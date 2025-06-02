# Trailhead MCP

A Model Context Protocol (MCP) server that automates Salesforce Trailhead interactions. This MCP provides tools to read Trailhead content, extract quiz questions, and automatically answer quizzes using AI assistance.

## Features

This MCP provides the following tools for Trailhead automation:

### 🔍 Content Reading
- **`get-current-trail-content`** - Extracts the current Trailhead page's educational content as text, which serves as the knowledge base for answering quizzes

### 📝 Quiz Interaction  
- **`get-trail-quiz-questions`** - Retrieves quiz questions and their multiple-choice options in JSON format
- **`answer-trail-quiz`** - Automatically submits quiz answers using option IDs (requires careful analysis of content)

### 🌐 Navigation
- **`goto-page`** - Navigate to specific Trailhead URLs

## How It Works

1. **Content Analysis**: The MCP reads the educational content from the current Trailhead page
2. **Quiz Extraction**: Extracts quiz questions and answer options with their IDs  
3. **AI-Powered Answering**: Uses the content to intelligently select correct answers
4. **Automated Submission**: Submits the quiz and confirms completion

## Prerequisites

- [Bun](https://bun.sh) runtime
- Chrome/Chromium browser (used by Puppeteer)

## Installation

```bash
bun install
```

## Usage

### Development Mode
```bash
bun run dev
```

### Production Build
```bash
bun run build
```

### Standalone Executable
```bash
bun run compile
```

## Important Notes

- The browser launches in non-headless mode by default for visibility during automation
- Always ensure you're on the correct Trailhead page before using quiz tools
- The MCP carefully analyzes content before selecting answers to ensure accuracy
- Quiz submissions are automatically confirmed when possible

## MCP Integration

This server implements the Model Context Protocol and can be integrated with MCP-compatible clients. It runs on stdio transport and provides structured tools for Trailhead automation.

---

This project was created using `bun init` in bun v1.2.2. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
