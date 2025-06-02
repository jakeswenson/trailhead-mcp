import type { Browser } from "puppeteer";
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

// Create server instance
const server = new McpServer({
  name: "trailhead-helper",
  version: "1.0.0",
});

// Launch the browser and open a new blank page
let browser: Browser;

async function setupBrowser() {
  browser = await puppeteer.launch({
    headless: false, // Set to true in production
    defaultViewport: null, // Use default viewport of the browser
  });

  return browser.pages().then((r) => r[0]);
}

export class Lazy<T> {
  private instance: T | undefined;
  private initializer: () => T;

  constructor(initializer: () => T) {
    this.initializer = initializer;
  }

  public get value(): T {
    if (this.instance === undefined) {
      this.instance = this.initializer();
    }

    return this.instance;
  }
}

const browserPage = new Lazy(setupBrowser);

server.tool(
  "get-current-trail-content",
  "Get the current salesforce trailhead page's content as text. The answers to the quizzes will be based on this content.",
  async () => {
    const page = await browserPage.value;
    return {
      content: [
        {
          type: "text",
          text:
            (await page.$eval("article > div.unit-content", (el) =>
              el.textContent?.trim(),
            )) ?? "",
        },
      ],
    };
  },
);

async function getQuestionJson(): Promise<string> {
  const page = await browserPage.value;

  try {
    // Wait for the challenge div to be present
    await page.waitForSelector("article > div#challenge", { timeout: 100 });

    // Click to expand the challenge if it's not expanded
    const challengeDiv = await page.$("article > div#challenge");
    if (challengeDiv) {
      await challengeDiv.click();
      // Wait for the quiz to be visible
      await page
        .waitForSelector("th-enhanced-quiz", { timeout: 500 })
        .catch((e) => {
          console.error("Error waiting for th-enhanced-quiz", e);
          throw e;
        });
    }

    // Get all questions and their options
    // Try to find questions with modern selector
    const questionsContainer = await page.$(
      "article >>> div#challenge >>> .quiz-container .questions",
    );
    if (questionsContainer) {
      const questions = await questionsContainer.$$(".question");

      const questionList = await Promise.all(
        questions.map(async (questionEl, questionIndex) => {
          const questionTextEl = await questionEl.$(".question-label");
          const questionText = questionTextEl
            ? await questionTextEl.evaluate((e) => e.textContent?.trim())
            : `Question ${questionIndex + 1}`;

          const optionEls = await questionEl.$$(".option");

          const options = await Promise.all(
            optionEls.map(async (optionEl, optionIndex) => {
              const optionText =
                (await optionEl.$eval(".option-text", (e) =>
                  e.textContent?.trim(),
                )) || "";
              const optionId = optionEl
                ? await optionEl.$eval("input", (e) => e.id)
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

      return JSON.stringify({ questions: questionList }, null, 2);
    } else {
      return "Error: coudn't find questions container";
    }
  } catch (error) {
    console.error("Error getting quiz structure:", error);
    return JSON.stringify(
      {
        questions: [],
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    );
  }
}

server.tool(
  "get-trail-quiz-questions",
  "Get the current pages quiz questions as a JSON string",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: await getQuestionJson(),
        },
      ],
    };
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
    const page = await browserPage.value;
    let result = "";
    const { optionIds } = params;

    try {
      // Wait for the challenge div to be present
      await page.waitForSelector("#challenge", { timeout: 10000 });

      // Click to expand the challenge if it's not expanded
      const challengeDiv = await page.$("#challenge");
      if (challengeDiv) {
        await challengeDiv.click();
        // Wait for the quiz to be visible
        await page.waitForSelector("th-enhanced-quiz", { timeout: 5000 });
      }

      // Select each answer by ID
      for (let i = 0; i < optionIds.length; i++) {
        const optionId = optionIds[i];

        // Try to click the option by ID
        try {
          // First try to find and click the label associated with the input
          const labelExists = await page.evaluate((id: any) => {
            const input = document.getElementById(id);
            if (input && input.parentElement) {
              input.parentElement.click();
              return true;
            }
            return false;
          }, optionId);

          if (!labelExists) {
            // If that fails, try other methods
            await page.evaluate((id: any) => {
              const input = document.getElementById(id);
              if (input) {
                input.click();
              }
            }, optionId);
          }

          console.log(`Selected answer with ID ${optionId}`);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          console.error(`Error selecting option ${optionId}:`, error);
          result += `\nFailed to select option ${optionId}: ${errorMessage}`;
        }
      }

      // Submit the quiz - try multiple selector patterns
      const submitButtonSelectors = [
        "th-enhanced-quiz .submit-button",
        "button.tds-button--primary",
        ".challenge-quiz-submit",
        'tds-button[type="submit"]',
        "button.submit",
      ];

      let submitted = false;
      for (const selector of submitButtonSelectors) {
        try {
          const submitButtonExists = await page.$(selector);
          if (submitButtonExists) {
            await page.click(selector);
            submitted = true;
            console.log(`Submitted quiz with selector: ${selector}`);
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
          await page.waitForSelector(".challenge-completed", {
            timeout: 10000,
          });
          result = "Quiz completed successfully!";
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

    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  },
);

server.tool(
  "goto-page",
  "Navigate to a specific page",
  {
    url: z.string().url().describe("The URL to navigate to"),
  },
  async ({ url }) => {
    const page = await browserPage.value;
    try {
      await page.goto(url, { waitUntil: "networkidle2" });
      const title = await page.title();
      return {
        content: [
          {
            type: "text",
            text: `Successfully navigated to: ${title}`,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Error navigating to page: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  },
);

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
  console.log("Closing browser before exit...");
  if (browser) {
    const closePromise = browser.close().catch(console.error);
    closePromise.finally(() => {
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});
