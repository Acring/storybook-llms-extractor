import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { existsSync } from 'node:fs';

import { type BrowserContext, type Page, chromium } from 'playwright';
import Turndown from 'turndown';
import { strikethrough, tables, taskListItems } from 'turndown-plugin-gfm';

import type { Args, StorybookComponentProp, StorybookComponent, StorybookStoreItem } from './types';

/**
 * Get content type based on file extension
 */
function getContentType(ext: string): string {
  const contentTypes: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  };

  return contentTypes[ext] || 'application/octet-stream';
}

/**
 * Sets up static file serving using Playwright's page.route
 */
async function setupStaticRouting(page: Page, distPath: string) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    let filePath = url.pathname;

    // Remove leading slash and resolve relative to distPath
    if (filePath.startsWith('/')) {
      filePath = filePath.substring(1);
    }

    // If no file extension, try to serve index.html
    if (!extname(filePath)) {
      filePath = join(filePath, 'index.html');
    }

    const fullPath = resolve(distPath, filePath);

    try {
      // Security check: ensure file is within distPath
      if (existsSync(fullPath) && fullPath.startsWith(resolve(distPath))) {
        const content = await readFile(fullPath);
        const contentType = getContentType(extname(fullPath));

        await route.fulfill({
          status: 200,
          contentType,
          body: content,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          },
        });
      } else {
        await route.fulfill({
          status: 404,
          body: 'File not found',
        });
      }
    } catch (error) {
      console.error(`Error serving file ${fullPath}:`, error);
      await route.fulfill({
        status: 500,
        body: 'Internal server error',
      });
    }
  });
}

/**
 * Extracts data for all stories, including `MDX` stories.
 * Now uses Playwright routing instead of Express server.
 */
export async function extractStorybookData({ distPath }: Args): Promise<StorybookStoreItem[]> {
  console.log(`▶️ Setting up Playwright with static file routing...`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ bypassCSP: true });

  try {
    console.log(`✔️ Static file routing configured for ${distPath}`);

    // Extract all stories from Storybook store
    const storeItems = await extractAllStoriesFromStorybook(context, distPath);

    // Extract content for all MDX pages
    console.log(`Processing ${storeItems.length} store items...`);
    for (const item of storeItems) {
      if (!item || !item.stories) {
        console.warn('Skipping invalid item:', item);
        continue;
      }
      const stories = Object.values(item.stories);

      if (stories.length > 0) {
        for (const story of stories) {
          if (story.parameters?.docsOnly) {
            const pageUrl = `http://localhost/iframe.html?id=${story.id.replace('--page', '--docs')}`;
            story.parameters.fullSource = await extractMDXStoryContentWithBrowser(pageUrl, context, distPath);
          }
        }
      } else if (item.meta.parameters.fileName.endsWith('.mdx')) {
        const pageUrl = `http://localhost/iframe.html?id=${item.meta.id.replace('--page', '--docs')}`;
        item.stories[`${item.meta.id}`] = {
          id: item.meta.id,
          name: item.meta.title,
          parameters: {
            fullSource: await extractMDXStoryContentWithBrowser(pageUrl, context, distPath),
            docsOnly: true,
            docs: {},
          },
        };
      }
    }

    console.log(`✔️ Extracted ${storeItems.length} stories from Storybook store.`);

    return storeItems;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Storybook Client API store, contains methods to cache CSF files and cached items.
 */
type StorybookStoryStore = {
  /**
   * Caches all CSF files in the Storybook store.
   * This method must be called before accessing `cachedCSFFiles`.
   */
  cacheAllCSFFiles?: () => Promise<void>;
  /**
   * CSF files become available after `cacheAllCSFFiles()` is resolved.
   **/
  cachedCSFFiles?: Record<string, StorybookStoreItem>;
  
  // Additional properties for different Storybook versions
  cache?: Record<string, StorybookStoreItem>;
  stories?: Record<string, StorybookStoreItem>;
  extract?: () => Promise<Record<string, StorybookStoreItem>>;
  
  // Allow any additional properties for flexibility
  [key: string]: any;
};

/**
 * Storybook Client API store, contains methods to cache CSF files.
 */
interface StorybookGlobals extends Window {
  /**
   * Storybook Client API, contains story store and other metadata.
   * `storyStore` is used for Storybook 7, `storyStoreValue` for >= 8.
   */
  __STORYBOOK_PREVIEW__?: {
    storyStore?: StorybookStoryStore;
    storyStoreValue?: StorybookStoryStore;
    extract?: () => Promise<Record<string, StorybookStoreItem>>;
    [key: string]: any;
  };
}

/**
 * Extracts all stories from Storybook Client API store.
 */
async function extractAllStoriesFromStorybook(context: BrowserContext, distPath: string) {
  const page = await context.newPage();

  // Set up static file routing for this page
  await setupStaticRouting(page, distPath);

  await page.goto(`http://localhost/iframe.html`);

  // Wait for the Storybook Client API to be loaded
  await page.waitForFunction(() => {
    return (window as StorybookGlobals).__STORYBOOK_PREVIEW__;
  });

  const stories: StorybookStoreItem[] = await page.evaluate(async () => {
    /**
     * Retrieves the Storybook story store from the global window object.
     *
     * @param window Storybook globals object
     * @throws If unable to find Storybook preview or story store
     */
    const getStoryStore = (window: StorybookGlobals) => {
      const preview = window.__STORYBOOK_PREVIEW__;

      if (!preview) {
        throw new Error('Unable to find Storybook preview');
      }

      console.log('Preview object keys:', Object.keys(preview));

      if ('storyStore' in preview && preview.storyStore) {
        console.log('Found storyStore in preview');
        return preview.storyStore;
      }

      if ('storyStoreValue' in preview && preview.storyStoreValue) {
        console.log('Found storyStoreValue in preview');
        return preview.storyStoreValue;
      }

      throw new Error('Unable to find Storybook story store');
    };

    const preview = (window as StorybookGlobals).__STORYBOOK_PREVIEW__;
    
    if (!preview) {
      throw new Error('Unable to find Storybook preview');
    }
    
    console.log('Preview object keys:', Object.keys(preview));
    
    // Try using preview.extract() first (recommended for newer Storybook versions)
    if (typeof preview.extract === 'function') {
      console.log('Found preview.extract method, using it...');
      const extracted = await preview.extract();
      console.log('preview.extract completed, extracted items count:', Object.keys(extracted).length);
      
      // Convert individual stories to StorybookStoreItem format
      const storyItems = Object.values(extracted) as any[];
      const groupedByComponent = new Map<string, StorybookStoreItem>();
      
      for (const story of storyItems) {
        const componentId = story.componentId || story.id?.split('--')[0] || 'unknown';
        
        if (!groupedByComponent.has(componentId)) {
          // Create meta object from story data
          groupedByComponent.set(componentId, {
            meta: {
              id: componentId,
              title: story.title || story.kind || 'Unknown',
              parameters: {
                fileName: story.parameters?.fileName || '',
                docs: story.parameters?.docs || {},
              },
            },
            stories: {},
          });
        }
        
        const item = groupedByComponent.get(componentId)!;
        item.stories[story.id] = {
          id: story.id,
          name: story.name || story.story,
          parameters: story.parameters || {},
        };
      }
      
      console.log('Converted to StorybookStoreItem format, component count:', groupedByComponent.size);
      return Array.from(groupedByComponent.values());
    }

    // Fallback to storyStore approach for older versions
    const storyStore = getStoryStore(window as StorybookGlobals);
    
    console.log('Story store object keys:', Object.keys(storyStore));
    console.log('Story store cacheAllCSFFiles method:', typeof storyStore.cacheAllCSFFiles);

    // Try different approaches based on Storybook version
    if (typeof storyStore.cacheAllCSFFiles === 'function') {
      console.log('Calling cacheAllCSFFiles...');
      await storyStore.cacheAllCSFFiles();
      console.log('cacheAllCSFFiles completed');
    } else {
      console.log('cacheAllCSFFiles method not found, trying alternative approaches');
    }

    // Check different possible properties for cached files
    if (storyStore.cachedCSFFiles) {
      console.log('Found cachedCSFFiles, count:', Object.keys(storyStore.cachedCSFFiles).length);
      return Object.values(storyStore.cachedCSFFiles);
    }

    // Try alternative property names for different Storybook versions
    if (storyStore.cache) {
      console.log('Found cache property, trying to use it');
      return Object.values(storyStore.cache);
    }

    if (storyStore.stories) {
      console.log('Found stories property, trying to use it');
      return Object.values(storyStore.stories);
    }

    console.log('Available preview properties:', Object.keys(preview));
    console.log('Available storyStore properties:', Object.keys(storyStore));
    throw new Error('Unable to find cached CSF files in Storybook store. Available preview properties: ' + Object.keys(preview).join(', ') + '. Available storyStore properties: ' + Object.keys(storyStore).join(', '));
  });

  await page.close();
  return stories;
}

/**
 * Extracts `MDX` story content from a given URL using a browser.
 */
async function extractMDXStoryContentWithBrowser(url: string, context: BrowserContext, distPath: string) {
  try {
    const page = await context.newPage();

    // Set up routing for this page
    await setupStaticRouting(page, distPath);

    console.log(`Extracting: "${url}"`);
    await page.goto(url);
    await page.waitForSelector('.sbdocs-content', { state: 'attached', timeout: 2000 });
    const html = await page.locator('.sbdocs-content').innerHTML();
    await page.close();
    return convertHtmlToMarkdown(html);
  } catch (error) {
    console.error(`❌ Failed to extract: ${url}`, error);
    return '';
  }
}

/**
 * Converts HTML content to markdown.
 */
export async function convertHtmlToMarkdown(htmlContent: string) {
  /**
   * Disable HTML escaping for the Turndown service.
   *
   * https://github.com/mixmark-io/turndown?tab=readme-ov-file#overriding-turndownserviceprototypeescape
   **/
  Turndown.prototype.escape = (str: string) => str;

  const turndown = new Turndown({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });

  // GitHub Flavored Markdown rules
  turndown.use([strikethrough, tables, taskListItems]);

  // Code block rule
  turndown.addRule('codeBlock', {
    filter(node) {
      return node.nodeName === 'PRE';
    },
    replacement(content, node) {
      // Extract language from any element with class containing "language-"
      const languageElement = node.querySelector('[class*="language-"]');
      let language = '';
      if (languageElement) {
        const classNames = languageElement.className.split(' ');
        const languageClass = classNames.find((cls: string) => cls.startsWith('language-'));
        if (languageClass) {
          language = languageClass.replace('language-', '');
        }
      }

      const normalizedContent = content.trim();

      if (normalizedContent.startsWith('```')) {
        return normalizedContent;
      }

      return `\`\`\`${language}\n${normalizedContent}\n\`\`\``;
    },
  });

  // Remove unnecessary anchor links
  turndown.addRule('removeAnchorLinks', {
    filter(node) {
      return (
        node.tagName === 'A' &&
        (node.getAttribute('href') === null ||
          node.getAttribute('href')?.startsWith('#') ||
          node.getAttribute('aria-hidden') === 'true' ||
          node.getAttribute('tabindex') === '-1')
      );
    },
    replacement: () => '',
  });

  // Remove other unnecessary elements
  turndown.addRule('removeElements', {
    filter: ['button', 'style', 'script', 'img'],
    replacement: () => '',
  });

  // Convert to markdown
  return turndown.turndown(htmlContent);
}

/**
 * Writes the summary file for all store items.
 */
export async function writeSummaryFile(args: Required<Args>, data: StorybookStoreItem[]) {
  const summaryContent = generateSummaryContent(args, data);
  await writeFile(join(args.distPath, 'llms.txt'), summaryContent.join('\n'));
  console.log(`✅ LLMs docs summary written to ${join(args.distPath, 'llms.txt')}`);
}

/**
 * Writes HTML summary and sitemap files after component files are written.
 * This ensures they are not deleted when the llms directory is cleaned.
 */
export async function writeAdditionalFiles(args: Required<Args>, data: StorybookStoreItem[]) {
  // Generate HTML summary for better indexing
  await writeSummaryHtmlFile(args, data);
  
  // Generate sitemap.xml for better SEO and indexing
  await writeSitemapFile(args, data);
}

/**
 * Generates the summary file content from the storeItems array.
 */
export function generateSummaryContent(
  { summaryTitle, summaryDescription, summaryBaseUrl, refs }: Required<Args>,
  data: StorybookStoreItem[],
) {
  // Initialize summary array with header content
  const summary: string[] = [
    `# ${summaryTitle}`,
    '',
    '> **Note:** This is a summary overview using the LLMs.txt format (https://llmstxt.org/). Each section links to its full documentation file in plain text (.txt) format. Click any link below to view the detailed documentation for that section.',
    '',
    summaryDescription,
    '',
  ];

  // Adds links to all components/pages
  for (const item of data) {
    let description = item.meta.parameters?.docs?.description?.component || '';
    if (description) {
      description = `: ${description.split('\n')[0]}`;
    }
    summary.push(`- [${item.meta.title}](${summaryBaseUrl}/llms/${item.meta.id}.html)${description}`);
  }

  // Adds links to all composed Storybook
  if (refs && refs.length > 0) {
    summary.push('');
    summary.push('## Optional');
    summary.push('');
    for (const ref of refs) {
      summary.push(`- [${ref.title}](${ref.url.replace(/\/$/, '')}/llms.txt)`);
    }
    summary.push('');
  }

  return summary;
}

/**
 * Writes the HTML summary file for all store items.
 * This provides better indexing support for Cursor and other tools.
 */
export async function writeSummaryHtmlFile(args: Required<Args>, data: StorybookStoreItem[]) {
  const llmsDir = join(args.distPath, 'llms');
  await mkdir(llmsDir, { recursive: true });
  const htmlContent = generateSummaryHtmlContent(args, data);
  await writeFile(join(llmsDir, 'index.html'), htmlContent);
  console.log(`✅ LLMs docs HTML summary written to ${join(llmsDir, 'index.html')}`);
}

/**
 * Generates the HTML summary file content from the storeItems array.
 */
export function generateSummaryHtmlContent(
  { summaryTitle, summaryDescription, summaryBaseUrl, refs }: Required<Args>,
  data: StorybookStoreItem[],
): string {
  const htmlParts: string[] = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${summaryTitle}</title>`,
    '  <style>',
    '    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 1200px; margin: 0 auto; padding: 20px; }',
    '    h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }',
    '    h2 { color: #34495e; margin-top: 30px; }',
    '    .note { background: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0; }',
    '    .component-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin: 20px 0; }',
    '    .component-card { border: 1px solid #ddd; border-radius: 8px; padding: 15px; background: #fff; transition: box-shadow 0.2s; }',
    '    .component-card:hover { box-shadow: 0 4px 8px rgba(0,0,0,0.1); }',
    '    .component-link { text-decoration: none; color: #2980b9; font-weight: 500; }',
    '    .component-link:hover { color: #3498db; }',
    '    .component-description { color: #666; margin-top: 5px; font-size: 0.9em; }',
    '    .refs-list { list-style: none; padding: 0; }',
    '    .refs-list li { background: #f1f8ff; border: 1px solid #c8e6ff; border-radius: 6px; padding: 10px; margin: 10px 0; }',
    '    .refs-list a { color: #0366d6; text-decoration: none; font-weight: 500; }',
    '    .refs-list a:hover { text-decoration: underline; }',
    '  </style>',
    '</head>',
    '<body>',
    `  <h1>${summaryTitle}</h1>`,
    '  <div class="note">',
    '    <strong>注意：</strong> 这是使用 LLMs.txt 格式的摘要概览 (<a href="https://llmstxt.org/" target="_blank">https://llmstxt.org/</a>)。',
    '    每个部分都链接到其纯文本格式 (.txt) 的完整文档文件。点击下面的任何链接查看该部分的详细文档。',
    '  </div>',
  ];

  if (summaryDescription) {
    htmlParts.push(`  <p>${summaryDescription}</p>`);
  }

  htmlParts.push('  <h2>组件文档</h2>');
  htmlParts.push('  <div class="component-list">');

  // Add component cards
  for (const item of data) {
    const rawDescription = item.meta.parameters?.docs?.description?.component;
    let description = '';
    if (rawDescription) {
      const firstLine = rawDescription.split('\n')[0];
      description = firstLine || ''; // Handle potential undefined
    }
    
    htmlParts.push('    <div class="component-card">');
    htmlParts.push(`      <a href="${summaryBaseUrl}/llms/${item.meta.id}.html" class="component-link" target="_blank">${item.meta.title}</a>`);
    if (description) {
      htmlParts.push(`      <div class="component-description">${description}</div>`);
    }
    htmlParts.push('    </div>');
  }

  htmlParts.push('  </div>');

  // Add composed Storybook references if any
  if (refs && refs.length > 0) {
    htmlParts.push('  <h2>相关 Storybook</h2>');
    htmlParts.push('  <ul class="refs-list">');
    for (const ref of refs) {
      htmlParts.push(`    <li><a href="${ref.url.replace(/\/$/, '')}/llms.txt" target="_blank">${ref.title}</a></li>`);
    }
    htmlParts.push('  </ul>');
  }

  htmlParts.push('</body>');
  htmlParts.push('</html>');

  return htmlParts.join('\n');
}

/**
 * Writes full markdown files for all components from `storeItems`.
 * For MDX pages, render only `fullSource`. For others, render title, description, props, and examples.
 * Now generates both .txt and .html files.
 */
export async function writeFullDocsFiles({ distPath }: Required<Args>, data: StorybookStoreItem[]) {
  const llmsDir = join(distPath, 'llms');

  // Clean up `llms` directory
  await rm(llmsDir, { recursive: true, force: true });
  await mkdir(llmsDir, { recursive: true });

  for (const item of data) {
    // Generate .txt file (original format)
    const txtFilePath = join(llmsDir, `${item.meta.id}.txt`);
    const txtContent = generateFullFileContentFromStory(item);
    await writeFile(txtFilePath, txtContent.join('\n'));
    
    // Generate .html file (new format)
    const htmlFilePath = join(llmsDir, `${item.meta.id}.html`);
    const htmlContent = generateFullFileHtmlContentFromStory(item);
    await writeFile(htmlFilePath, htmlContent);
  }
}

/**
 * Generates the full HTML content for a given storybook story.
 */
export function generateFullFileHtmlContentFromStory(item: StorybookStoreItem): string {
  const stories = Object.values(item.stories);
  const isMDXPage = stories.every(s => s.parameters?.docsOnly);

  const htmlParts: string[] = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${item.meta.title}</title>`,
    '  <style>',
    '    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height: 1.6; max-width: 1200px; margin: 0 auto; padding: 20px; color: #333; }',
    '    h1 { color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 10px; }',
    '    h2 { color: #34495e; margin-top: 30px; border-bottom: 1px solid #eee; padding-bottom: 5px; }',
    '    h3 { color: #2c3e50; margin-top: 25px; }',
    '    h4 { color: #34495e; margin-top: 20px; }',
    '    table { border-collapse: collapse; width: 100%; margin: 20px 0; }',
    '    th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }',
    '    th { background-color: #f8f9fa; font-weight: 600; }',
    '    code { background: #f1f3f4; padding: 2px 6px; border-radius: 3px; font-family: "SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace; }',
    '    pre { background: #f8f9fa; border: 1px solid #e1e4e8; border-radius: 6px; padding: 16px; overflow-x: auto; }',
    '    pre code { background: none; padding: 0; }',
    '    .example-section { background: #f8f9fa; border-left: 4px solid #3498db; padding: 15px; margin: 20px 0; border-radius: 0 6px 6px 0; }',
    '    .props-table th { background-color: #e8f4fd; }',
    '    .back-link { display: inline-block; margin-bottom: 20px; color: #3498db; text-decoration: none; }',
    '    .back-link:hover { text-decoration: underline; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <a href="./index.html" class="back-link">← 返回总览</a>',
    `  <h1>${item.meta.title}</h1>`,
  ];

  if (isMDXPage) {
    // For MDX pages, just render the full source content
    const content = stories.map(s => s.parameters?.fullSource ?? '').filter(Boolean).join('\n\n');
    if (content) {
      // Convert markdown to HTML (simple conversion)
      const htmlContent = convertMarkdownToHtml(content);
      htmlParts.push(`  <div class="mdx-content">${htmlContent}</div>`);
    }
  } else {
    // For component pages, render structured content
    const description = extractStoryDescription(item);
    if (description) {
      htmlParts.push(`  <p>${description}</p>`);
    }

    const props = extractComponentProps(item.meta.component);
    if (props.length > 0) {
      htmlParts.push('  <h2>Props</h2>');
      htmlParts.push('  <table class="props-table">');
      htmlParts.push('    <thead>');
      htmlParts.push('      <tr>');
      htmlParts.push('        <th>Name</th>');
      htmlParts.push('        <th>Type</th>');
      htmlParts.push('        <th>Required</th>');
      htmlParts.push('        <th>Default</th>');
      htmlParts.push('        <th>Description</th>');
      htmlParts.push('      </tr>');
      htmlParts.push('    </thead>');
      htmlParts.push('    <tbody>');
      
      for (const prop of props) {
        htmlParts.push('      <tr>');
        htmlParts.push(`        <td><code>${prop.name}</code></td>`);
        htmlParts.push(`        <td><code>${stringifyPropType(prop.type)}</code></td>`);
        htmlParts.push(`        <td>${prop.required ? 'Yes' : 'No'}</td>`);
        htmlParts.push(`        <td>${prop.defaultValue ? `<code>${prop.defaultValue}</code>` : ''}</td>`);
        htmlParts.push(`        <td>${prop.description?.replace(/\n/g, ' ') ?? ''}</td>`);
        htmlParts.push('      </tr>');
      }
      
      htmlParts.push('    </tbody>');
      htmlParts.push('  </table>');
    }

    // Subcomponents
    if (item.meta.subcomponents) {
      htmlParts.push('  <h2>Subcomponents</h2>');

      for (const [name, subcomponent] of Object.entries(item.meta.subcomponents)) {
        const docgen = subcomponent?.__docgenInfo;
        if (!docgen) {
          continue;
        }

        htmlParts.push(`  <h3>${name}</h3>`);
        if (docgen.description) {
          htmlParts.push(`  <p>${docgen.description}</p>`);
        }

        const subcomponentProps = extractComponentProps(subcomponent);
        if (subcomponentProps.length > 0) {
          htmlParts.push('  <h4>Props</h4>');
          htmlParts.push('  <table class="props-table">');
          htmlParts.push('    <thead>');
          htmlParts.push('      <tr>');
          htmlParts.push('        <th>Name</th>');
          htmlParts.push('        <th>Type</th>');
          htmlParts.push('        <th>Required</th>');
          htmlParts.push('        <th>Default</th>');
          htmlParts.push('        <th>Description</th>');
          htmlParts.push('      </tr>');
          htmlParts.push('    </thead>');
          htmlParts.push('    <tbody>');
          
          for (const prop of subcomponentProps) {
            htmlParts.push('      <tr>');
            htmlParts.push(`        <td><code>${prop.name}</code></td>`);
            htmlParts.push(`        <td><code>${stringifyPropType(prop.type)}</code></td>`);
            htmlParts.push(`        <td>${prop.required ? 'Yes' : 'No'}</td>`);
            htmlParts.push(`        <td>${prop.defaultValue ? `<code>${prop.defaultValue}</code>` : ''}</td>`);
            htmlParts.push(`        <td>${prop.description?.replace(/\n/g, ' ') ?? ''}</td>`);
            htmlParts.push('      </tr>');
          }
          
          htmlParts.push('    </tbody>');
          htmlParts.push('  </table>');
        }
      }
    }

    // Examples
    const examples = Object.values(item.stories).map(s => ({
      title: s.name,
      description: s.parameters?.docs?.description?.story,
      source: s.parameters?.fullSource ?? s.parameters.docs?.source?.originalSource,
    }));

    if (examples.length > 0) {
      htmlParts.push('  <h2>Examples</h2>');
      for (const ex of examples) {
        htmlParts.push('  <div class="example-section">');
        htmlParts.push(`    <h3>${ex.title}</h3>`);
        if (ex.description) {
          htmlParts.push(`    <p>${ex.description}</p>`);
        }
        if (ex.source) {
          htmlParts.push('    <pre><code class="language-tsx">');
          htmlParts.push(ex.source.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;'));
          htmlParts.push('    </code></pre>');
        }
        htmlParts.push('  </div>');
      }
    }
  }

  htmlParts.push('</body>');
  htmlParts.push('</html>');

  return htmlParts.join('\n');
}

/**
 * Simple markdown to HTML converter for basic content
 */
function convertMarkdownToHtml(markdown: string): string {
  return markdown
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/^(.*)$/gm, '<p>$1</p>')
    .replace(/<p><h/g, '<h')
    .replace(/<\/h([1-6])><\/p>/g, '</h$1>')
    .replace(/<p><\/p>/g, '');
}

/**
 * Generates the full markdown content for a given storybook story.
 */
export function generateFullFileContentFromStory(item: StorybookStoreItem) {
  const stories = Object.values(item.stories);
  const isMDXPage = stories.every(s => s.parameters?.docsOnly);

  if (isMDXPage) {
    return stories.map(s => s.parameters?.fullSource ?? '').filter(Boolean);
  }

  const content: string[] = [];
  content.push(`# ${item.meta.title}`);
  content.push('');
  const description = extractStoryDescription(item);
  if (description) {
    content.push(description);
    content.push('');
  }
  const props = extractComponentProps(item.meta.component);
  if (props.length > 0) {
    content.push('## Props');
    content.push('');
    content.push(...generateComponentPropsTable(props));
    content.push('');
  }

  if (item.meta.subcomponents) {
    content.push('## Subcomponents');
    content.push('');

    for (const [name, subcomponent] of Object.entries(item.meta.subcomponents)) {
      const docgen = subcomponent?.__docgenInfo;
      if (!docgen) {
        continue;
      }

      content.push('');
      content.push(`### ${name}`);
      content.push('');
      content.push(docgen.description ?? '');
      content.push('');

      const subcomponentProps = extractComponentProps(subcomponent);
      if (subcomponentProps.length > 0) {
        content.push('#### Props');
        content.push('');
        content.push(...generateComponentPropsTable(subcomponentProps));
        content.push('');
      }
    }
  }

  const examples = Object.values(item.stories).map(s => ({
    title: s.name,
    description: s.parameters?.docs?.description?.story,
    source: s.parameters?.fullSource ?? s.parameters.docs?.source?.originalSource,
  }));
  if (examples.length > 0) {
    content.push('## Examples');
    content.push('');
    for (const ex of examples) {
      content.push('');
      content.push(`### ${ex.title}`);
      content.push('');
      if (ex.description) {
        content.push(ex.description);
        content.push('');
      }
      if (ex.source) {
        content.push('```tsx');
        content.push(ex.source.trim());
        content.push('```');
      }
    }
  }
  return content;
}

/**
 * Converts a docgen type object to a readable string for markdown tables.
 */
function stringifyPropType(type: StorybookComponentProp['type']): string {
  if (!type) {
    return '';
  }
  if (typeof type === 'string') {
    return type;
  }
  if (typeof type === 'object' && type !== null && 'name' in type && typeof type.name === 'string') {
    // Handle enums, unions, arrays, etc.
    if (type.name === 'enum' && Array.isArray(type.value)) {
      return type.value.map(v => (typeof v.value === 'string' ? v.value : JSON.stringify(v.value))).join(' ');
    }
    if (type.name === 'union' && Array.isArray(type.value)) {
      return type.value.map(v => (typeof v.value === 'string' ? v.value : JSON.stringify(v.value))).join(' ');
    }
    if (type.name === 'array' && type.value) {
      return `${stringifyPropType(type.value as StorybookComponentProp['type'])}[]`;
    }
    if (type.name === 'signature' && type.value?.[0]?.value === 'function') {
      // Function signature
      return 'function';
    }
    return type.name;
  }
  return JSON.stringify(type);
}

/**
 * Extracts the description from a storybook story.
 */
function extractStoryDescription(story: StorybookStoreItem) {
  return story.meta.parameters?.docs?.description?.component || undefined;
}

/**
 * Extracts the props from a storybook story.
 */
function extractComponentProps(component?: StorybookComponent) {
  const docgen = component?.__docgenInfo;
  if (!docgen || !docgen.props) {
    return [];
  }
  const props: StorybookComponentProp[] = [];
  for (const [name, arg] of Object.entries(docgen.props)) {
    if (name === 'children') {
      continue;
    }
    props.push({
      name,
      description: arg.description || '',
      type: arg.type ?? {},
      defaultValue: typeof arg.defaultValue === 'string' ? arg.defaultValue : arg.defaultValue?.value || '',
      required: arg.required ?? false,
    });
  }
  return props;
}

function generateComponentPropsTable(props: StorybookComponentProp[]): string[] {
  const content: string[] = [];

  if (props.length === 0) {
    return content;
  }

  content.push('');
  content.push('| Name | Type | Required | Default | Description |');
  content.push('|------|------|----------|---------|-------------|');
  for (const prop of props) {
    content.push(
      `| ${[
        `\`${prop.name}\``,
        `\`${stringifyPropType(prop.type)}\``,
        prop.required ? 'Yes' : 'No',
        prop.defaultValue ?? '',
        prop.description?.replace(/\n/g, ' ') ?? '',
      ].join(' | ')} |`,
    );
  }
  content.push('');

  return content;
}

/**
 * Writes the sitemap.xml file for all store items.
 * This provides better SEO and indexing support for search engines and crawlers.
 */
export async function writeSitemapFile(args: Required<Args>, data: StorybookStoreItem[]) {
  const llmsDir = join(args.distPath, 'llms');
  const sitemapContent = generateSitemapContent(args, data);
  await writeFile(join(llmsDir, 'sitemap.xml'), sitemapContent);
  console.log(`✅ Sitemap written to ${join(llmsDir, 'sitemap.xml')}`);
}

/**
 * Generates the sitemap.xml content from the storeItems array.
 */
export function generateSitemapContent(
  { summaryBaseUrl }: Required<Args>,
  data: StorybookStoreItem[],
): string {
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  
  const sitemapParts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '',
    '  <!-- Main summary page -->',
    '  <url>',
    `    <loc>${summaryBaseUrl}/llms.txt</loc>`,
    `    <lastmod>${currentDate}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '',
    '  <!-- HTML summary index -->',
    '  <url>',
    `    <loc>${summaryBaseUrl}/llms/index.html</loc>`,
    `    <lastmod>${currentDate}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    '    <priority>0.9</priority>',
    '  </url>',
    '',
  ];

  // Add individual component/page URLs
  for (const item of data) {
    sitemapParts.push('  <!-- Component/Page documentation -->');
    
    // Add .txt file
    sitemapParts.push('  <url>');
    sitemapParts.push(`    <loc>${summaryBaseUrl}/llms/${item.meta.id}.txt</loc>`);
    sitemapParts.push(`    <lastmod>${currentDate}</lastmod>`);
    sitemapParts.push('    <changefreq>weekly</changefreq>');
    sitemapParts.push('    <priority>0.8</priority>');
    sitemapParts.push('  </url>');
    
    // Add .html file
    sitemapParts.push('  <url>');
    sitemapParts.push(`    <loc>${summaryBaseUrl}/llms/${item.meta.id}.html</loc>`);
    sitemapParts.push(`    <lastmod>${currentDate}</lastmod>`);
    sitemapParts.push('    <changefreq>weekly</changefreq>');
    sitemapParts.push('    <priority>0.7</priority>');
    sitemapParts.push('  </url>');
    sitemapParts.push('');
  }

  sitemapParts.push('</urlset>');

  return sitemapParts.join('\n');
}
