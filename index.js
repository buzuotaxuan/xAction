#!/usr/bin/env node

/**
 * X 书签 → Notion（增量同步，登录失败邮件通知，同步后取消书签）
 */

import puppeteer from 'puppeteer';
import { loginWithCookie, scrapeBookmarks, scrapeThread } from 'xactions';
import { Client } from '@notionhq/client';
import nodemailer from 'nodemailer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 邮件通知 ─────────────────────────────────────────────────────

async function sendAlertEmail(subject, body) {
  const config = JSON.parse(process.env.SMTP_CONFIG || '{}');
  if (!config.host || !config.user || !config.pass || !config.to) {
    console.log('⚠️  邮件配置不完整，跳过通知');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: parseInt(config.port) || 465,
      secure: true,
      auth: { user: config.user, pass: config.pass },
    });
    await transporter.sendMail({
      from: config.user, to: config.to,
      subject: `[X→Notion] ${subject}`, text: body,
    });
    console.log('📧 通知邮件已发送');
  } catch (err) {
    console.error(`📧 邮件发送失败: ${err.message}`);
  }
}

// ─── 取消书签 ─────────────────────────────────────────────────────

async function unbookmarkTweet(page, tweetUrl) {
  await page.goto(tweetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  try {
    await page.waitForSelector('[data-testid="removeBookmark"]', { timeout: 5000 });
    await page.click('[data-testid="removeBookmark"]');
    return { success: true };
  } catch {
    try {
      await page.waitForSelector('[data-testid="bookmark"]', { timeout: 3000 });
      return { success: true, already: true };
    } catch {
      return { success: false, error: '找不到书签按钮' };
    }
  }
}

// ─── 内容提取 ─────────────────────────────────────────────────────

async function extractTweetContent(page, url) {
  // 使用 xactions 的 scrapeThread 获取推文内容
  const thread = await scrapeThread(page, url);
  const main = thread[0] || {};

  // 再提取图片和卡片链接
  const extra = await page.evaluate(() => {
    const article = document.querySelector('article[data-testid="tweet"]');
    if (!article) return { images: [], cardUrl: '', cardTitle: '' };

    const images = Array.from(article.querySelectorAll('img[src*="media"]'))
      .map(img => img.src)
      .filter((src, i, arr) => arr.indexOf(src) === i);

    const cardEl = article.querySelector('[data-testid="card.wrapper"]');
    let cardUrl = '';
    let cardTitle = '';
    if (cardEl) {
      const linkEl = cardEl.querySelector('a[href]');
      cardUrl = linkEl?.href || '';
      cardTitle = cardEl.querySelector('span')?.textContent || '';
    }

    return { images, cardUrl, cardTitle };
  });

  return {
    text: main.text || '',
    author: main.author || '',
    time: main.timestamp || '',
    images: extra.images,
    cardUrl: extra.cardUrl,
    cardTitle: extra.cardTitle,
  };
}

function buildBlocks(text, images, link, cardUrl, cardTitle) {
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
  if (cardUrl) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block', type: 'bookmark',
      bookmark: { url: cardUrl, caption: cardTitle ? [{ type: 'text', text: { content: cardTitle } }] : [] },
    });
  }
  if (link) {
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
      object: 'block', type: 'paragraph',
      paragraph: { rich_text: [
        { type: 'text', text: { content: '🔗 原文: ' } },
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
      blocks.push({ object: 'block', type: 'image', image: { type: 'external', external: { url: imgUrl } } });
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
    if (linkProp?.type === 'url' && linkProp.url) return linkProp.url;
    return null;
  } catch { return null; }
}

// ─── 主流程 ────────────────────────────────────────────────────────

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
  if (cursorLink) console.log(`   游标: ${cursorLink}`);
  else console.log('   数据库为空，全量同步');

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
  } catch (err) {
    console.error(`❌ 登录失败: ${err.message}`);
    await sendAlertEmail('登录失败', `X 书签同步登录失败\n\n时间: ${new Date().toISOString()}\n错误: ${err.message}`);
    await browser.close();
    process.exit(1);
  }

  try {
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
    filtered.reverse();

    console.log(`共 ${bookmarks.length} 条，需同步 ${filtered.length} 条\n`);
    if (filtered.length === 0) { console.log('✨ 无新增'); await browser.close(); return; }

    let uploaded = 0;
    for (let i = 0; i < filtered.length; i++) {
      const bm = filtered[i];
      const title = bm.text ? bm.text.split('\n')[0].slice(0, 80) : '(无文字)';

      try {
        process.stdout.write(`📥 ${i + 1}/${filtered.length} ${title}... `);
        const tweet = await extractTweetContent(page, bm.link);
        console.log(`text=${tweet.text.length}字 card=${tweet.cardUrl ? '有' : '无'} img=${tweet.images.length}`);

        if (tweet.text.length > 0) {
          const blocks = buildBlocks(tweet.text, tweet.images, bm.link, tweet.cardUrl, tweet.cardTitle);
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
          const result = await unbookmarkTweet(page, bm.link);
          console.log(`   ✅${result.already ? ' (已取消)' : ''}`);
        } else {
          console.log('   ⚠️  文本为空');
        }
      } catch (err) {
        console.log(`   ❌ ${err.message}`);
        if (err.code === 'validation_error' || err.code === 'object_not_found') break;
      }
    }
    console.log(`\n✅ 完成 ${uploaded}/${filtered.length}`);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
