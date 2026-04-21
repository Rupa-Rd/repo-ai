#!/usr/bin/env node
import chalk from 'chalk';
import figlet from 'figlet';
import gradient from 'gradient-string';
import { createSpinner } from 'nanospinner';
import { text, isCancel, intro, outro } from '@clack/prompts';
import { repoIndexer, queryAI } from './main.js';

// 1. The Big Header (Visual Hook)
console.log(
  gradient.pastel.multiline(
    figlet.textSync('REPO - AI', { horizontalLayout: 'full' })
  )
);

async function startInteractiveSession() {
  // 2. The Details & Intro
  intro(chalk.bgCyan.black(' System Engineer Mode Active '));
  console.log(chalk.dim(' v1.0.2 | Connected to Ollama (gemma3:4b)\n'));

  // 3. THE INFINITE LOOP
  while (true) {
    const query = await text({
      message: 'What do you want to know?',
      placeholder: 'Type /help for commands...',
      validate(value) {
        if (value.length === 0) return `Please enter a question!`;
      },
    });

    // Handle Ctrl+C or Escape
    if (isCancel(query)) {
      outro(chalk.magenta('Goodbye! Happy coding.'));
      process.exit(0);
    }

    // 4. Handle Slash Commands (Internal Logic)
    if (query.startsWith('/')) {
      if (query === '/clear') {
        console.clear();
        continue;
      }
      if (query === '/exit') break;
      if (query === '/ask') {
    // 1. Start the spinner
    const spinner = createSpinner('Initializing AI search...').start();
    
    try {
        // 2. Capture the actual user question
        // If your 'query' variable currently is just "/ask", 
        // you'll need to prompt for the actual question or parse it.
        const question = await text({
            message: 'What is your question about the codebase?',
            placeholder: 'e.g., How does the authentication flow work?'
        });

        if (isCancel(question)) {
            spinner.error({ text: 'Question cancelled.' });
            continue;
        }

        // 3. Call queryAI and pass the spinner
        const response = await queryAI(spinner, question);

        // 4. Output the result
        // We use a box or a specific color to separate AI text from the CLI UI
        // console.log(`\n${chalk.cyan('✨ Ollama-AI:')}\n${response}\n`);

    } catch (err) {
        // Fallback in case queryAI fails and doesn't catch internally
        spinner.error({ text: 'Error processing your request.' });
        console.error(chalk.red(err.message));
    }
    continue;
}
      if (query === '/help') {
        console.log(chalk.blue(`
      Available Commands:
      /help   - Show this help message
      /clear  - Clear the terminal
      /exit   - Exit the session
      /index  - Index the codebase
      /query   - Ask a question about the codebase
      /summarize - Summarize the entire codebase (coming soon)
      /dependencies - List all dependencies and their versions (coming soon)
      /gitstatus - Show current git status and recent commits (coming soon)
      /
            `));
        continue;
      }
    }

    if (query === '/index') {
      const indexSpinner = createSpinner('Initializing indexing of the codebase...').start();
      try {
        await repoIndexer(indexSpinner); 
        // await new Promise(r => setTimeout(r, 2000));
        indexSpinner.success({ text: chalk.green('Indexing completed!'), mark: '✨' });

      }
      catch (err) {
        indexSpinner.error({ text: 'Indexing failed!' });
        console.error(chalk.dim(err.stack || err));
      }
      continue;
    }

  }

  outro(chalk.magenta('Session ended.'));
}

startInteractiveSession();