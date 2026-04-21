#!/usr/bin/env node

// Imports
import fs from 'fs';
import ignore from 'ignore';
import path, { normalize } from 'path';
import parser from 'tree-sitter';
import javascriptParser from 'tree-sitter-javascript';
import { cat, pipeline } from '@huggingface/transformers';
import * as lancedb from '@lancedb/lancedb';
import { table } from 'console';
import {Ollama} from 'ollama';
import { createSpinner } from 'nanospinner';
import chalk from 'chalk';
import os from 'os';
import { fileURLToPath } from 'url';
import { get } from 'http';
// import path from 'path';

// Get the directory of the current file (main.js in your bin folder)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Read Config File
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    ollamaEndpoint: 'http://localhost:11434',
    embeddingModel: 'nomic-embed-text',
    chatModel: 'qwen2.5-coder:1.5b'
};

export function getConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return DEFAULT_CONFIG;
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}


// Initializations
const ig = ignore()
if (fs.existsSync('.gitignore')) {
    const gitignoreContent = fs.readFileSync('.gitignore', 'utf-8');
    ig.add(gitignoreContent.split('\n').filter(line => line.trim() !== ''));
}

const new_parser = new parser();
new_parser.setLanguage(javascriptParser);

const APP_DIR = path.join(getConfig().homeDir, '.repo-ai');
const dbPath = path.join(APP_DIR, getConfig().databasePath);

export function ensureDataDir() {
    if (!fs.existsSync(APP_DIR)) {
        fs.mkdirSync(APP_DIR, { recursive: true });
    }
    return VECTOR_STORE_PATH;
}

const embedder = await pipeline('feature-extraction', getConfig().embeddingModel);
const db = await lancedb.connect(getConfig);

const ollama = new Ollama({ host: getConfig().ollamaEndpoint });

// TODO 1: Read folder structure and files in the current directory. Skip Nodemodules (for now).
const readDirectory = (dir, pageContent = []) => {


    const allFiles = fs.readdirSync(dir);

    for (const file of allFiles) {
        const fullPath = path.join(dir, file);

        const relativePath = path.relative(process.cwd(), fullPath);

        if (ig.ignores(relativePath)) return;

        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            readDirectory(fullPath, pageContent);
        } else {
            const fileExtension = ['.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.mdx', '.html', '.css', '.scss', '.less', '.yaml', '.yml', '.xml', '.csv', '.py', '.java']; // Add more extensions as needed
            if (fileExtension.includes(path.extname(fullPath))) {
                const content = fs.readFileSync(fullPath, 'utf-8');
                pageContent.push({
                    path: relativePath,
                    content: content,
                });
            }

        }
    }
    return pageContent;
}

// TODO 2: Chunk the file content into smaller pieces for better processing by AI models.
const processFile = (fileContent, filePath) => {
    const programFiles = ['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.scss', '.java'];
    const configFiles = ['.json', '.yaml', '.yml', '.xml'];
    const docFiles = ['.md', '.mdx'];
    const ext = path.extname(filePath);
    if (programFiles.includes(ext)) {
        // Process program files (e.g., JavaScript, TypeScript, Python, etc.)
        return prepareChunks(fileContent, filePath);
    } else if (configFiles.includes(ext)) {
        // Process configuration files (e.g., JSON, YAML, XML, etc.)
        return [{
            metadata: {
                path: filePath,
                type: 'config',
            },
            content: fileContent,
        }];
    } else if (docFiles.includes(ext)) {
        // Process documentation files (e.g., Markdown, etc.)
        return [{
            metadata: {
                path: filePath,
                type: 'documentation',
            },
            content: fileContent,
        }];
    }
    return [];
};

const prepareChunks = (fileContent, filePath) => {
    // Parse the file content and create chunks based on logical code blocks (e.g., functions, classes, etc.)
    const chunks = [];
    const tree = new_parser.parse(fileContent);
    const nodeTypes = ['function_declaration',
        'method_definition',
        'variable_declarator',
        'class_declaration',
        'generator_function_declaration'];
    // Traverse the syntax tree and create chunks based on node types (e.g., function declarations, class declarations, etc.)
    const traverseNode = (node) => {
        if (node.type === 'function_declaration' || node.type === 'variable_declarator') {
            const chunk = fileContent.substring(node.startIndex, node.endIndex);
            chunks.push({
                metadata: {
                    path: filePath,
                    type: node.type,
                    name: node.childForFieldName('name') ? node.childForFieldName('name').text : 'anonymous',
                },
                content: node.text,
            });
        }
        for (const child of node.children) {
            traverseNode(child);
        }

    };

    traverseNode(tree.rootNode);

    return chunks;

}
// TODO 3: Create embeddings for the file chunks and store them in a vector database for efficient retrieval during AI interactions.

async function createEmbeddings(text) {
    try{
        const embeddings = await embedder(text, {pooling: 'mean', normalize: true});
        chalk.green('✅ Embeddings created successfully!');
        return Array.from(embeddings.data);
    }catch(err) {
        chalk.red('Error creating embeddings:'), chalk.dim(err.stack || err);
        throw new Error('Failed to create embeddings');
    }
    
}

async function indexEmbeddings(chunks, tableName) {
    const data = [];

    for (const chunk of chunks) {
        const vector = await createEmbeddings(chunk.content);
        // console.log("Sample embedding for chunk:", vector.slice(0, 5)); // Print first 5 dimensions for brevity
        data.push({
            metadata: JSON.stringify(chunk.metadata),
            text: chunk.content,
            vector: vector,
        });
    }

    const existingTables = await db.tableNames();

    if (existingTables.includes(tableName)) {
        console.log(`✅ Table "${tableName}" already exists. Skipping creation.`);
        return await db.openTable(tableName);
    }
    console.log(`🚀 Creating table "${tableName}" and indexing embeddings...`);
    const table = db.createTable(tableName, data, {writeMode: 'overwrite'});

}

async function ensureIndex(parentSpinner) {
    const table = await db.openTable('repo_vectors');
    const indices = await table.listIndices();
    const hasTextIndex = indices.some(index => index.name === 'vector');
    
    if (!hasTextIndex) {
        parentSpinner.update({ 
            text: chalk.cyan('Creating index on the "text" field for efficient retrieval...') 
        });
        await table.createIndex('text', {
            config: lancedb.Index.fts(),
            type: "fts",
        });
    } else {
        console.log(chalk.green('✅ Index on "text" field already exists. Skipping index creation.'));
    }   
}

let rrfReranker = null;

async function getReranker(){
    if(rrfReranker) return rrfReranker;

    console.log(chalk.cyan('Initializing RRF Reranker...'));
    rrfReranker = await lancedb.rerankers.RRFReranker.create();
    console.log(chalk.green('RRF Reranker initialized successfully!'));
    return rrfReranker;
}


// TODO 4: Implement an interface (CLI or web-based) for users to interact with the AI, ask questions about the codebase, and receive relevant information based on the stored embeddings.
// DONE IN index.js

// TODO 5: Integrate with LLMs
async function queryLLM(query, context, parentSpinner) {
    try {
        const systemPrompt = `You are an expert AI Software Architect and Interactive Technical Documentation system. Your primary goal is to help developers navigate, understand, and document the specific codebase provided in the context.

OPERATIONAL GUIDELINES:

Contextual Grounding: Your knowledge is strictly limited to the retrieved codebase chunks provided in the context. If a question cannot be answered using the provided context, state that clearly rather than hallucinating.

Structural Awareness: When explaining logic, reference specific file paths, class names, and function signatures found in the context.

Documentation Excellence: When asked to generate documentation, follow standard conventions (e.g., JSDoc, TSDoc, or Google-style Docstrings) and ensure the technical complexity matches a professional engineering standard.

Code Navigation: Act as a map. Explain how different modules interact, the data flow between services, and the purpose of specific design patterns implemented in the code.

Conciseness & Precision: Developers value efficiency. Provide direct, technically accurate answers. Avoid fluff and keep explanations focused on implementation details.

Language Specificity: Adapt your technical advice based on the languages and frameworks detected in the context (e.g., Node.js, Python, Rust).

RESPONSE FORMATTING:

Use Markdown for code blocks, including the language identifier.

Use bold text for file names and function names.

Use bullet points for step-by-step logic flows or architectural breakdowns.

CONSTRAINTS:

Do not provide general coding advice that contradicts the patterns established in the current codebase.

Maintain a helpful, neutral, and highly technical tone.

If the user asks for a feature that would break the existing architecture, provide a warning along with your suggestion.`;
        const response = await ollama.chat({
            model: getConfig().chatModel, 
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Context: ${context}\n\nQuestion: ${query}` }
            ],
            stream: true, // Enable streaming responses
        });

        let fullResponse = "";
        let isFirstChunk = true;
        for await (const part of response) {    
            if (isFirstChunk) {
                parentSpinner.success({ text: chalk.green('Repo-AI: ') });
                process.stdout.write('\n');
                isFirstChunk = false;
            }
            
            process.stdout.write(chalk.green(part.message.content)); 
            // process.stdout.write(part.message.content); // Stream to terminal
            fullResponse += part.message.content;
        }
        return fullResponse;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            return "❌ Error: Ollama is not running. Please start the Ollama app.";
        }
        throw error;
    }
}

// TODO 6: Implement Git mechanisms to track changes in the codebase and update embeddings accordingly, ensuring that the AI has access to the most up-to-date information for accurate responses.

// TODO 7: Give access to execute commands to understand dependencies version and conflicts.

// TODO 8: Implement functionality for slash commands

// Slash Command: /index - To index the codebase
export async function repoIndexer(parentSpinner) {
    const fileContents = readDirectory('./');
    const chunks = [];

    // 1. Update the parent spinner instead of creating a new one
    parentSpinner.update({ 
        text: chalk.cyan('🔍 Scanning directory and preparing chunks...') 
    });

    for (const content of fileContents) {
        try {
            // Optional: Show the current file being processed
            parentSpinner.update({ 
                text: `Processing: ${chalk.dim(content.path)}` 
            });

            const chunk = processFile(content.content, content.path);
            chunks.push(...chunk);
        } catch (error) {
            // Use warn so the spinner doesn't stop for a single file error
            console.log(chalk.yellow(`\n⚠️  Skipped ${content.path}: ${error.message}`));
        }
    }

    // 2. Moving to the heavy lifting (Embeddings)
    parentSpinner.update({ 
        text: chalk.magenta('🧠 Generating embeddings (this may take a minute)...') 
    });

    try {
        await indexEmbeddings(chunks, 'repo_vectors'); 
        
        // 3. Final Success
        parentSpinner.success({ 
            text: chalk.green(`Successfully indexed ${fileContents.length} files into LanceDB!`) 
        });
    } catch (error) {
        parentSpinner.error({ text: 'Failed to index embeddings.' });
        console.error(error);
    }

    // 3. Create index
    parentSpinner.update({ 
        text: chalk.cyan('Creating index on the "text" field for efficient retrieval...') 
    });
    try{
        await ensureIndex(parentSpinner);
        parentSpinner.success({ text: chalk.green('Index created successfully!') });
    }catch(err) {
        parentSpinner.error({ text: 'Failed to create index.' });
        console.error(err);
    }

    
    // 4. Create Reranker
    parentSpinner.update({
        text: chalk.cyan('Initializing RRF Reranker...') 
    });
    try {
        await getReranker();
        parentSpinner.success({ text: chalk.green('RRF Reranker initialized successfully!') });
    } catch (err) {
        parentSpinner.error({ text: 'Failed to initialize RRF Reranker.' });
        console.error(err);
    }
    
}

// Slash command: /query - To ask questions about the codebase
export async function queryAI(parentSpinner, query) {
    try {
        // 1. Semantic Preparation
        parentSpinner.update({ 
            text: `🧠 ${chalk.cyan('Generating query embeddings...')}` 
        });
        const queryEmbedding = await createEmbeddings(query);

        // 2. Local Knowledge Retrieval
        parentSpinner.update({ 
            text: `🔍 ${chalk.blue('Searching LanceDB (Hybrid + RRF)...')}` 
        });
        
        const table = await db.openTable(getConfig().tableName);
        const reranker = await getReranker(); // Uses your singleton
        let context = null;
        // Note: Using the 2026 builder pattern for Hybrid Search
        try{
            context = await table
            .query()
            .fullTextSearch(query)
            .nearestTo(queryEmbedding)
            .rerank(reranker)
            .select(["text"])
            .limit(5)
            .toArray();
            console.log(chalk.green('✅ Retrieved relevant information from LanceDB!'));

        }catch(err) { 
            parentSpinner.error({ text: 'Failed to retrieve relevant information from LanceDB.' });
            console.error(chalk.red('Error during LanceDB query:'), chalk.dim(err.stack || err));
            return "Sorry, I couldn't retrieve information from the codebase.";
        }
        
        // 3. LLM Interaction
        parentSpinner.update({ 
            text: `📡 ${chalk.magenta('Consulting Ollama with context...')}` 
        });

        const llmResponse = await queryLLM(query, context, parentSpinner);

        // 4. Cleanup
        // parentSpinner.success();
        
        return llmResponse;

    } catch (error) {
        parentSpinner.error({ text: chalk.red('Query failed!') });
        console.error(chalk.dim(error.stack));
        return "Sorry, I encountered an error while searching the codebase.";
    }
}