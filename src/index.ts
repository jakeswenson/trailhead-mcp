#!/usr/bin/env bun
import type { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Define types for quiz structure
interface QuizOption {
  id: string;
  text: string;
  index: number;
}

interface QuizQuestion {
  text: string;
  options: QuizOption[];
}

interface QuizStructure {
  questions: QuizQuestion[];
  error?: string;
}

type McpResponse = {
  content: {
    type: "text";
    text: string;
  }[];
  isError?: boolean;
};

// Helper functions for MCP responses
function createMcpResponse(text: string, isError: boolean = false): McpResponse {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
    ...(isError && { isError: true }),
  };
}

function createMcpError(message: string, originalError?: Error): McpResponse {
  const errorMessage = originalError 
    ? `${message}: ${originalError.message}`
    : message;
  
  console.error("MCP Error:", errorMessage);
  
  return createMcpResponse(errorMessage, true);
}

// Create server instance
const server = new McpServer({
  name: "trailhead-mcp",
  version: "1.0.0",
});

// Browser management
let browser: Browser;
let currentPage: Page | null = null;

async function setupBrowserConnection(): Promise<Browser> {
  // Try to connect to existing browser instances first
  const debuggingPorts = [9222, 9223, 9224];
  
  for (const port of debuggingPorts) {
    try {
      console.error(`Trying to connect to existing browser on port ${port}...`);
      const connectedBrowser = await puppeteer.connect({
        browserURL: `http://localhost:${port}`,
      });
      console.error(`✓ Connected to existing browser on port ${port}`);
      return connectedBrowser;
    } catch (error) {
      // Continue to next port
    }
  }

  // If no existing browser found, launch a new one
  console.error("No existing browser found. Launching new browser...");
  console.error("Tip: To use your current browser, start Chrome with: google-chrome --remote-debugging-port=9222");
  
  return await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: "/tmp/trailhead-mcp-user-data",
    args: [
      '--restore-last-session',           // Restore tabs from the previous session
      '--disable-session-crashed-bubble', // Prevent "Chrome didn't shut down correctly" popup
      '--disable-infobars',               // Remove info bars that might interfere
      '--no-first-run',                   // Skip first-run setup
    ],
  });
}

server.tool(
  "get-current-trail-content",
  "Get the current salesforce trailhead page's content as text. The answers to the quizzes will be based on this content.",
  {},
  async () => {
    if (!(await isTrailheadPage())) {
      return createMcpError(TRAILHEAD_ERROR_MESSAGE);
    }
    const page = await getCurrentPage();
    return createMcpResponse(
      (await page.$eval("article > div.unit-content", (el: any) =>
        el.textContent?.trim(),
      )) ?? ""
    );
  },
);

async function getQuestionJson(): Promise<McpResponse> {
  const page = await getCurrentPage();

  try {
    // Wait for the challenge div to be present
    await page.waitForSelector("article >>> div#challenge", { timeout: 100 });

    // Click to expand the challenge if it's not expanded
    const challengeDiv = await page.$("article >>> div#challenge");
    if (challengeDiv) {
      await challengeDiv.click();
      // Wait for the quiz to be visible
      await page
        .waitForSelector("div#challenge .th-enhanced-quiz, div#challenge .th-quiz", { timeout: 500 })
        .catch((e: any) => {
          console.error("Error waiting for quiz", e);
        });
    }

    // Find questions using selectors that work for both old and new structures
    const questions = await page.$$("article >>> div#challenge .question, article >>> div#challenge fieldset.th-quiz__question");

    if (questions.length > 0) {
      const questionList = await Promise.all(
        questions.map(async (questionEl: any, questionIndex: any) => {
          const questionTextEl = await questionEl.$(".question-label, .th-quiz__question-text");
          const questionText = questionTextEl
            ? await questionTextEl.evaluate((e: any) => e.textContent?.trim())
            : `Question ${questionIndex + 1}`;

          const optionEls = await questionEl.$$(".option, .slds-radio_button");

          const options = await Promise.all(
            optionEls.map(async (optionEl: any, optionIndex: any) => {
              const optionText =
                (await optionEl.$eval(".option-text, .th-quiz__item-text", (e: any) =>
                  e.textContent?.trim(),
                )) || "";
              const optionId = optionEl
                ? await optionEl.$eval("input", (e: any) => e.id)
                : `q${questionIndex}_o${optionIndex}`;

              return {
                id: optionId,
                text: optionText,
                index: optionIndex,
              };
            }),
          );

          return {
            text: questionText || `Question ${questionIndex + 1}`,
            options: options,
          };
        }),
      );

      return createMcpResponse(JSON.stringify({ questions: questionList }, null, 2));
    } else {
      return createMcpError("Could not find quiz questions");
    }
  } catch (error) {
    console.error("Error getting quiz structure:", error);
    return createMcpResponse(JSON.stringify(
      {
        questions: [],
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ));
  }
}

server.tool(
  "get-trail-quiz-questions",
  "Get the current pages quiz questions as a JSON string",
  {},
  async () => {
    if (!(await isTrailheadPage())) {
      return createMcpError(TRAILHEAD_ERROR_MESSAGE);
    }
    return await getQuestionJson();
  },
);

interface AnswerQuizParams {
  optionIds: string[];
}

server.tool(
  "answer-trail-quiz",
  "Submit answers to the quiz using option IDs. It is important that you use the current trailhead pages content, and think very very carefully to select the right option answer for each quiz question before calling this.",
  // Define schema object separately to avoid the "possibly undefined" error
  {
    optionIds: z
      .array(z.string())
      .describe(
        "Required array of option IDs to select (one per question) based on the trailhead pages content",
      ),
  },
  async (params: AnswerQuizParams) => {
    if (!(await isTrailheadPage())) {
      return createMcpError(TRAILHEAD_ERROR_MESSAGE);
    }
    const page = await getCurrentPage();
    let result = "";
    const { optionIds } = params;

    try {
      // Wait for the challenge div to be present
      await page.waitForSelector("main div#challenge", { timeout: 100 });

      // Click to expand the challenge if it's not expanded
      const challengeDiv = await page.$("main div#challenge");
      if (challengeDiv) {
        await challengeDiv.click();
        // Wait for the quiz to be visible
        await page.waitForSelector("div#challenge .th-enhanced-quiz, div#challenge .th-quiz", { timeout: 500 }).catch((e: any) => {
          console.error("Error waiting for quiz", e);
        });
      }

      // Select each answer by ID
      for (let i = 0; i < optionIds.length; i++) {
        const optionId = optionIds[i];

        // Try to click the option by ID
        try {
          await page.evaluate((id: any) => {
            const input = document.getElementById(id);
            if (input) {
              input.click();
            }
          }, optionId);

          console.error(`Selected answer with ID ${optionId}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`Error selecting option ${optionId}:`, error);
          result += `\nFailed to select option ${optionId}: ${errorMessage}`;
        }
      }

      // Submit the quiz - try multiple selector patterns
      const submitButtonSelectors = [
        ".th-challenge .th-button--success",
        ".th-enhanced-quiz .submit-button",
        ".th-quiz .submit-button",
        "button.tds-button--primary",
        ".challenge-quiz-submit",
        'tds-button[type="submit"]',
        "button.submit",
      ];

      let submitted = false;
      for (const selector of submitButtonSelectors) {
        try {
          const submitButtonExists = await page.$(selector);
        
          if (submitButtonExists && await submitButtonExists.evaluate((el) => {
            const button = el as HTMLButtonElement | HTMLInputElement;
            return !button.disabled; // Only proceed if button is enabled (not disabled)
          })) {
            await page.click(selector);
            submitted = true;
            console.error(`Submitted quiz with selector: ${selector}`);
            break;
          }
        } catch (error) {
          console.error(
            `Error with submit button selector ${selector}:`,
            error,
          );
        }
      }

      if (!submitted) {
        result =
          "Could not find a submit button to click. Please check manually.";
      } else {
        // Wait for confirmation of completion
        try {
          await page.waitForSelector(".challenge-completed, .th-challenge-complete", {
            timeout: 1000,
          });
          result = "Quiz completed successfully!";

          // Look for the "Tackle the next unit" button specifically
          try {
            // Use $$eval to find and click the button by text content
            const clicked = await page.$$eval('button', (buttons) => {
              for (const button of buttons) {
                if (button.textContent?.trim() === "Tackle the next unit") {
                  button.click();
                  return true;
                }
              }
              return false;
            });
            
            if (clicked) {
              result = "Quiz completed successfully! Browser is navigating to next trailhead module page...";
            } else {
              result = "Quiz completed successfully!";
            }
          } catch (nextButtonError) {
            // Don't fail the whole operation if next button doesn't work
            console.error("Error clicking next button:", nextButtonError);
            result = "Quiz completed successfully! (Note: Could not automatically navigate to next unit)";
          }
        } catch (error) {
          result =
            "Quiz was submitted, but couldn't confirm success. Please check manually.";
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result = `Error: ${errorMessage}`;
      console.error("Error in answer-quiz tool:", error);
    }

    return createMcpResponse(result);
  },
);

server.tool(
  "goto-page",
  "Navigate to a specific page",
  {
    url: z.string().url().describe("The URL to navigate to"),
  },
  async ({ url }) => {
    const page = await getCurrentPage();
    try {
      await page.goto(url, { waitUntil: "networkidle2" });
      const title = await page.title();
      return createMcpResponse(`Successfully navigated to: ${title}`);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return createMcpError(`Error navigating to page: ${errorMessage}`);
    }
  },
);

server.tool(
  "debug-selector",
  "Debug DOM selectors by testing them on the current page and returning detailed information about matching elements.",
  {
    selector: z.string().describe("The CSS selector or Puppeteer selector (including >>> for shadow DOM) to test"),
    verbose: z.boolean().optional().describe("If true, returns more detailed information about matching elements"),
  },
  async ({ selector, verbose = false }) => {
    const page = await getCurrentPage();
    try {
      // Test the selector and get detailed info about matching elements
      const selectorInfo = await page.evaluate((sel: any, isVerbose: any) => {
        const results: {
          selector: string;
          matchCount: number;
          elements: any[];
          error: string | null;
        } = {
          selector: sel,
          matchCount: 0,
          elements: [],
          error: null
        };

        try {
          // Try different selector methods
          let elements = [];
          // For shadow-piercing selectors (>>>) - use Puppeteer's method when available
          if (sel.includes('>>>')) {
            // For evaluation context, we'll try querySelector on document first
            // Note: >>> is handled by Puppeteer, not browser's querySelector
            try {
              const normalizedSel = sel.replace(/>>>/g, '').trim();
              elements = Array.from(document.querySelectorAll(normalizedSel));
            } catch (e) {
              results.error = `Shadow-piercing selector requires Puppeteer context: ${e}`;
              return results;
            }
          } else {
            // Regular CSS selector
            elements = Array.from(document.querySelectorAll(sel));
          }

          results.matchCount = elements.length;

          // Get details for first few elements (limit to avoid overwhelming output)
          const elementsToInspect = elements.slice(0, isVerbose ? 5 : 3);
          results.elements = elementsToInspect.map((el: any, index: any) => {
            const rect = el.getBoundingClientRect();
            const computedStyle = window.getComputedStyle(el);
            return {
              index,
              tagName: el.tagName.toLowerCase(),
              id: el.id || null,
              classes: Array.from(el.classList),
              attributes: Array.from(el.attributes).reduce((acc: any, attr: any) => {
                acc[attr.name] = attr.value;
                return acc;
              }, {}),
              textContent: el.textContent?.trim().substring(0, 200) || null,
              innerHTML: isVerbose ? el.innerHTML.substring(0, 300) : null,
              visible: rect.width > 0 && rect.height > 0 && computedStyle.visibility !== 'hidden' && computedStyle.display !== 'none',
              position: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              parent: el.parentElement ? {
                tagName: el.parentElement.tagName.toLowerCase(),
                id: el.parentElement.id || null,
                classes: Array.from(el.parentElement.classList)
              } : null
            };
          });

          // If there are more elements, add a summary
          if (elements.length > elementsToInspect.length) {
            (results as any).additionalElements = elements.length - elementsToInspect.length;
          }
        } catch (error) {
          results.error = error instanceof Error ? error.message : String(error);
        }

        return results;
      }, selector, verbose);

      // For shadow-piercing selectors, also try Puppeteer's $$ method
      if (selector.includes('>>>')) {
        try {
          const puppeteerElements = await page.$$(selector);
          (selectorInfo as any).puppeteerMatchCount = puppeteerElements.length;
          if (puppeteerElements.length > 0 && selectorInfo.matchCount === 0) {
            // Get info from Puppeteer elements if document.querySelector failed
            const elementDetails = await Promise.all(
              puppeteerElements.slice(0, verbose ? 5 : 3).map(async (el: any, index: any) => {
                const tagName = await el.evaluate((e: any) => e.tagName.toLowerCase());
                const id = await el.evaluate((e: any) => e.id);
                const classes = await el.evaluate((e: any) => Array.from(e.classList));
                const textContent = await el.evaluate((e: any) => e.textContent?.trim().substring(0, 200));
                const boundingBox = await el.boundingBox();
                return {
                  index,
                  tagName,
                  id: id || null,
                  classes,
                  textContent: textContent || null,
                  visible: !!boundingBox,
                  position: boundingBox ? {
                    x: Math.round(boundingBox.x),
                    y: Math.round(boundingBox.y),
                    width: Math.round(boundingBox.width),
                    height: Math.round(boundingBox.height)
                  } : null
                };
              })
            );
            selectorInfo.elements = elementDetails;
            selectorInfo.matchCount = puppeteerElements.length;
          }
        } catch (puppeteerError) {
          (selectorInfo as any).puppeteerError = puppeteerError instanceof Error ? puppeteerError.message : String(puppeteerError);
        }
      }

      // Format the response
      let response = `Selector Debug Results for: "${selector}"\n`;
      response += `═══════════════════════════════════════════\n\n`;

      if (selectorInfo.error) {
        response += `❌ Error: ${selectorInfo.error}\n`;
      } else {
        response += `✅ Found ${selectorInfo.matchCount} matching element(s)\n`;
        if ((selectorInfo as any).puppeteerMatchCount !== undefined) {
          response += `   (Puppeteer shadow-piercing: ${(selectorInfo as any).puppeteerMatchCount} matches)\n`;
        }

        if (selectorInfo.matchCount > 0) {
          response += `\n📋 Element Details:\n`;
          response += `───────────────────\n`;
          selectorInfo.elements.forEach((el: any, i: any) => {
            response += `\n[${i + 1}] <${el.tagName}`;
            if (el.id) response += ` id="${el.id}"`;
            if (el.classes.length > 0) response += ` class="${el.classes.join(' ')}"`;
            response += `>\n`;

            if (el.textContent) {
              response += `    📝 Text: "${el.textContent}"\n`;
            }
            response += `    👁️  Visible: ${el.visible ? '✅ YES' : '❌ NO'}\n`;
            if (el.position) {
              response += `    📍 Position: (${el.position.x}, ${el.position.y}) ${el.position.width}×${el.position.height}px\n`;
            }
            if (el.parent) {
              response += `    ⬆️  Parent: <${el.parent.tagName}`;
              if (el.parent.id) response += ` id="${el.parent.id}"`;
              if (el.parent.classes.length > 0) response += ` class="${el.parent.classes.join(' ')}"`;
              response += `>\n`;
            }
            if (verbose && el.innerHTML) {
              response += `    🔍 HTML: ${el.innerHTML.replace(/\n/g, ' ')}\n`;
            }
            if (verbose && Object.keys(el.attributes).length > 0) {
              response += `    🏷️  Attributes: ${JSON.stringify(el.attributes, null, 2)}\n`;
            }
          });

          if ((selectorInfo as any).additionalElements) {
            response += `\n... and ${(selectorInfo as any).additionalElements} more element(s)\n`;
          }
        } else {
          response += `\n💡 Suggestions:\n`;
          response += `   • Try a broader selector\n`;
          response += `   • Check if elements are in shadow DOM (use >>> syntax)\n`;
          response += `   • Verify the page has loaded completely\n`;
          response += `   • Use browser dev tools to inspect the DOM\n`;
        }
      }

      if ((selectorInfo as any).puppeteerError) {
        response += `\n⚠️  Puppeteer Error: ${(selectorInfo as any).puppeteerError}\n`;
      }

      return createMcpResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createMcpError(`Error debugging selector: ${errorMessage}`);
    }
  },
);

async function validatePage(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => true);
    return true;
  } catch (error) {
    return false;
  }
}

async function findActivePage(browser: Browser): Promise<Page> {
  const pages = await browser.pages();
  
  if (pages.length === 0) {
    // No pages exist, create a new one
    console.error("No pages found, creating new page");
    return await browser.newPage();
  }

  // Filter valid pages and try to find the active/focused one
  const validPages: Page[] = [];
  
  for (const page of pages) {
    if (await validatePage(page)) {
      validPages.push(page);
    }
  }

  if (validPages.length === 0) {
    // All pages are detached, create a new one
    console.error("All existing pages are detached, creating new page");
    return await browser.newPage();
  }

  // Filter for Trailhead pages specifically
  const trailheadPages: Page[] = [];
  for (const page of validPages) {
    try {
      const url = page.url();
      if (url.includes('my.trailhead.com') || url.includes('trailhead.salesforce.com')) {
        trailheadPages.push(page);
      }
    } catch (error) {
      // Skip pages where we can't get URL
    }
  }

  // Handle Trailhead page count
  if (trailheadPages.length === 1) {
    const trailheadPage = trailheadPages[0];
    const url = trailheadPage.url();
    console.error(`Using single Trailhead page: ${url}`);
    return trailheadPage;
  } else if (trailheadPages.length > 1) {
    // Multiple Trailhead pages found - throw error
    const urls = await Promise.all(trailheadPages.map(async (page) => {
      try {
        return page.url();
      } catch {
        return 'unknown';
      }
    }));
    throw new Error(`Multiple Trailhead tabs are open (${trailheadPages.length} found). Please close all but one Trailhead tab and try again. Open tabs: ${urls.join(', ')}`);
  }

  // No Trailhead pages found, fall back to original behavior
  // Try to find the focused page
  for (const page of validPages) {
    try {
      // Check if this page is currently focused
      const isFocused = await page.evaluate(() => document.hasFocus());
      if (isFocused) {
        const url = page.url();
        console.error(`Using focused page: ${url}`);
        return page;
      }
    } catch (error) {
      // Continue to next page if we can't check focus
    }
  }

  // If no focused page found, use the first valid page
  const firstPage = validPages[0];
  try {
    const url = firstPage.url();
    console.error(`No focused page found, using first valid page: ${url}`);
  } catch (error) {
    console.error(`No focused page found, using first valid page: unknown`);
  }
  
  return firstPage;
}

async function getCurrentPage(): Promise<Page> {
  // Initialize browser if needed
  if (!browser) {
    browser = await setupBrowserConnection();
  }

  // Check if current page is still valid
  if (currentPage && await validatePage(currentPage)) {
    return currentPage;
  }

  // Find and cache a new page
  console.error("Current page invalid or not set, finding best available page...");
  currentPage = await findActivePage(browser);
  return currentPage;
}

async function isTrailheadPage(): Promise<boolean> {
  try {
    const page = await getCurrentPage();
    const url = page.url();
    
    // Check if URL is a Trailhead domain
    if (!url.includes('trailhead.salesforce.com') && !url.includes('my.trailhead.com')) {
      return false;
    }
    
    // Check if page has Trailhead content structure
    const hasTrailheadContent = await page.$('article > div.unit-content');
    return !!hasTrailheadContent;
  } catch (error) {
    console.error("Error checking if page is Trailhead page:", error);
    return false;
  }
}

const TRAILHEAD_ERROR_MESSAGE = "Please navigate to a Salesforce Trailhead learning module page (trailhead.salesforce.com or my.trailhead.com) and sign in to your Salesforce account. This tool only works on Trailhead learning content pages.";

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Trailhead Helper MCP Server running on stdio");
}

server.server.onclose = () => {
  if (browser) {
    browser.close().catch(console.error);
  }
};

main().catch((error) => {
  console.error("Fatal error in main():", error);
  if (browser) {
    browser.close().catch(console.error);
  }
  process.exit(1);
});

// Ensure cleanup on process exit
process.on("SIGINT", () => {
  console.error("Closing browser before exit...");
  if (browser) {
    const closePromise = browser.close().catch(console.error);
    closePromise.finally(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
