#!/usr/bin/env node

/**
 * X 书签 → Notion（增量同步，取最新一条 Link 作为游标）
 */

import puppeteer from 'puppeteer';
import { loginWithCookie, scrapeBookmarks } from 'xactions';
import { Client } from '@notionhq/client';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function extractTweetContent(page, url) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  return await page.evaluate(() => {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return { text: '', author: '', time: '', images: [] };

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl?.textContent || textEl?.innerText || '';

    const authorEl = article.querySelector('[data-testid="User-Name"]');
    const author = authorEl?.querySelector('a')?.textContent || '';

    const timeEl = article.querySelector('time');
    const time = timeEl?.getAttribute('datetime') || '';

    const images = Array.from(article.querySelectorAll('img[src*="media"]'))
      .map(img => img.src)
      .filter((src, i, arr) => arr.indexOf(src) === i);

    return { text, author, time, images };
  });
}

function buildBlocks(text, images, link) {
  const blocks = [];

  if (text) {
    const paragraphs = text.split('\n').filter(Boolean);
    for (const p of paragraphs) {
      blocks.push({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] },
      });
    }
  }

  if (link) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [
        { type: 'text', text: { content: '🔗 ' } },
        { type: 'text', text: { content: link, link: { url: link } } },
      ]},
    });
  }

  if (images.length > 0) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block', type: 'heading_3',
      heading_3: { rich_text: [{ type: 'text', text: { content: '📷 图片' } }] },
    });
    for (const imgUrl of images) {
      blocks.push({
        object: 'block', type: 'image',
        image: { type: 'external', external: { url: imgUrl } },
      });
    }
  }

  return blocks;
}

async function getLatestLink(token, databaseId) {
  try {
    const resp = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sorts: [{ property: 'Create_Time', direction: 'descending' }],
        page_size: 1,
      }),
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    if (data.results.length === 0) return null;

    const linkProp = data.results[0].properties['Link'];
    if (linkProp?.type === 'url' && linkProp.url) {
      return linkProp.url;
    }
    return null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) || 100 : 100;

  const notionToken = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  const authToken = process.env.X_AUTH_TOKEN;

  if (!notionToken || !databaseId || !authToken) {
    console.error('❌ 缺少环境变量');
    process.exit(1);
  }

  console.log(`🚀 X 书签 → Notion (${new Date().toISOString()})`);
  console.log('='.repeat(60));

  const notion = new Client({ auth: notionToken });

  console.log('📋 获取游标...');
  const cursorLink = await getLatestLink(notionToken, databaseId);
  if (cursorLink) {
    console.log(`   游标: ${cursorLink}`);
  } else {
    console.log('   数据库为空，全量同步');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  try {
    console.log('🔐 登录...');
    await loginWithCookie(page, authToken);
    console.log('✅ 已登录');

    console.log(`📥 抓取书签 (${limit} 条)...`);
    const bookmarks = await scrapeBookmarks(page, { limit, scrollDelay: 1500 });

    if (bookmarks.length === 0) {
      console.log('😕 没有书签');
      await browser.close();
      return;
    }

    let filtered = bookmarks;
    if (cursorLink) {
      const matchIdx = bookmarks.findIndex(bm => bm.link === cursorLink);
      if (matchIdx !== -1) {
        filtered = bookmarks.slice(0, matchIdx);
        console.log(`   匹配游标位置 ${matchIdx + 1}，丢弃后续 ${bookmarks.length - matchIdx} 条`);
      }
    }

    console.log(`共 ${bookmarks.length} 条，需同步 ${filtered.length} 条\n`);

    if (filtered.length === 0) {
      console.log('✨ 无新增');
      await browser.close();
      return;
    }

    let uploaded = 0;
    for (let i = 0; i < filtered.length; i++) {
      const bm = filtered[i];
      const title = bm.text ? bm.text.split('\n')[0].slice(0, 80) : '(无文字)';

      try {
        process.stdout.write(`📥 ${i + 1}/${filtered.length} ${title}... `);
        const tweet = await extractTweetContent(page, bm.link);

        if (tweet.text.length > 0) {
          const blocks = buildBlocks(tweet.text, tweet.images, bm.link);

          await notion.pages.create({
            parent: { database_id: databaseId },
            properties: {
              Name: { title: [{ text: { content: title } }] },
              Author: { rich_text: [{ text: { content: bm.author || '' } }] },
              Link: { url: bm.link },
              Time: { date: { start: bm.time || new Date().toISOString() } },
              Create_Time: { number: Date.now() },
            },
            children: blocks,
          });

          uploaded++;
          console.log('✅');
        } else {
          console.log('⚠️ 文本为空');
        }
      } catch (err) {
        console.log(`❌ ${err.message}`);
        if (err.code === 'validation_error') {
          console.log('   请在 Notion 中将 Create_Time 改为数字类型');
          break;
        }
        if (err.code === 'object_not_found') break;
      }
      await sleep(500);
    }

    console.log(`\n✅ 完成 ${uploaded}/${filtered.length}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
