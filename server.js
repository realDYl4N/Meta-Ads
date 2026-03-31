/**
 * Meta Ad Library Scraper
 *
 * A tool for scraping and analyzing top-performing ads from Meta's Ad Library
 * for DTC brands.
 *
 * CUSTOMIZATION GUIDE:
 * - Add brands in the Brands section below
 * - Scraping integration will be added via Apify
 * - Edit views/index.html to customize the UI
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { ApifyClient } = require('apify-client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ============================================
// DATABASE SETUP
// ============================================
const fs = require('fs');
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const db = new Database(path.join(DB_DIR, 'app.db'));

function initDatabase() {
  db.exec(`
    -- Brands table: stores DTC brands to track
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      meta_ad_library_url TEXT NOT NULL UNIQUE,
      category TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Ads table: stores scraped ads from Meta Ad Library
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      ad_library_id TEXT UNIQUE,
      page_id TEXT,
      page_name TEXT,
      ad_snapshot_url TEXT,
      ad_creative_bodies TEXT,
      ad_creative_link_captions TEXT,
      ad_creative_link_titles TEXT,
      ad_creative_link_descriptions TEXT,
      is_active INTEGER,
      start_date TEXT,
      raw_data TEXT,
      scraped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );

    -- Scrape jobs table: tracks scraping job status
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER,
      apify_run_id TEXT,
      status TEXT DEFAULT 'pending',
      ads_found INTEGER DEFAULT 0,
      ads_saved INTEGER DEFAULT 0,
      error_message TEXT,
      started_at DATETIME,
      completed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id)
    );
  `);
}

initDatabase();

// Add ai_analysis column if it doesn't exist
try {
  db.exec(`ALTER TABLE ads ADD COLUMN ai_analysis TEXT`);
} catch (e) {
  // Column already exists, ignore
}

// ============================================
// CONFIGURATION
// ============================================
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_ID = 'JJghSZmShuco4j9gJ';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Initialize Apify client
const apifyClient = APIFY_TOKEN ? new ApifyClient({ token: APIFY_TOKEN }) : null;

// Initialize Gemini client
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ============================================
// GEMINI AI ANALYSIS
// ============================================

/**
 * Fetch an image/video URL and convert to base64
 */
async function fetchMediaAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return { base64, mimeType: contentType };
}

/**
 * Analyze an ad's creative (image or video) using Gemini
 */
async function analyzeAdWithGemini(ad) {
  if (!genAI) {
    throw new Error('Gemini API key not configured');
  }

  // Parse raw_data to get media URLs
  const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
  const card = rawData.snapshot?.cards?.[0] || {};

  // Check if it's a video or image
  const videoUrl = card.videoHdUrl || card.videoSdUrl;
  const imageUrl = card.originalImageUrl || card.resizedImageUrl;

  const isVideo = !!videoUrl;
  const mediaUrl = videoUrl || imageUrl;

  if (!mediaUrl) {
    throw new Error('No media URL found for this ad');
  }

  // Get the ad text for context
  const adText = ad.ad_creative_bodies || card.body || '';
  const adTitle = ad.ad_creative_link_titles || card.title || '';
  const brandName = ad.brand_name || ad.page_name || 'Unknown Brand';

  // Build the prompt
  const prompt = `You are an expert advertising analyst specializing in DTC (direct-to-consumer) brand marketing. Analyze this ${isVideo ? 'video' : 'image'} ad creative from ${brandName}.

Ad Copy: ${adText}
${adTitle ? `Headline: ${adTitle}` : ''}

Please provide a comprehensive analysis covering:

1. **Visual Analysis**: Describe the key visual elements, composition, colors, and overall aesthetic.

2. **Messaging & Hook**: What is the main value proposition? How does the creative grab attention?

3. **Target Audience**: Who is this ad targeting? What demographics/psychographics?

4. **Call to Action**: What action is the viewer being asked to take?

5. **Strengths**: What makes this ad effective?

6. **Areas for Improvement**: What could be done better?

7. **Performance Prediction**: Based on the creative, would you expect this ad to perform well? Why?

Keep your analysis concise but insightful, focusing on actionable takeaways.`;

  try {
    // Use gemini-2.0-flash for efficiency (handles both images and videos)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    // Fetch and convert media to base64
    const { base64, mimeType } = await fetchMediaAsBase64(mediaUrl);

    // Create the content with inline data
    const result = await model.generateContent([
      {
        inlineData: {
          mimeType: mimeType,
          data: base64
        }
      },
      { text: prompt }
    ]);

    const response = await result.response;
    return {
      analysis: response.text(),
      mediaType: isVideo ? 'video' : 'image',
      mediaUrl: mediaUrl,
      model: 'gemini-2.0-flash'
    };
  } catch (error) {
    console.error('Gemini analysis error:', error);
    throw new Error(`Gemini analysis failed: ${error.message}`);
  }
}

// ============================================
// MOCK DATA FUNCTIONS
// ============================================

function getMockBrands() {
  return [
    { id: 1, name: 'Glossier', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=183869772601', category: 'Beauty', is_active: 1 },
    { id: 2, name: 'Warby Parker', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=115496702', category: 'Fashion & Apparel', is_active: 1 },
    { id: 3, name: 'Allbirds', meta_ad_library_url: 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&is_targeted_country=false&media_type=all&search_type=page&sort_data[direction]=desc&sort_data[mode]=total_impressions&view_all_page_id=1247829371897498', category: 'Fashion & Apparel', is_active: 1 }
  ];
}

function getMockAds() {
  return [
    {
      id: 1,
      brand_id: 1,
      ad_library_id: 'mock_ad_001',
      page_name: 'Glossier',
      ad_creative_bodies: 'Discover our new skincare line. Clean beauty that works.',
      is_active: 1,
      start_date: '2024-01-15',
      scraped_at: new Date().toISOString()
    },
    {
      id: 2,
      brand_id: 1,
      ad_library_id: 'mock_ad_002',
      page_name: 'Glossier',
      ad_creative_bodies: 'The internet\'s favorite lip gloss. Now in 12 shades.',
      is_active: 1,
      start_date: '2024-01-20',
      scraped_at: new Date().toISOString()
    }
  ];
}

// ============================================
// ROUTES - PAGES
// ============================================

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// ============================================
// ROUTES - BRANDS API
// ============================================

// Get all brands
app.get('/api/brands', (req, res) => {
  try {
    const brands = db.prepare('SELECT * FROM brands ORDER BY created_at DESC').all();

    // Return mock data if database is empty (demo mode)
    if (brands.length === 0) {
      return res.json(getMockBrands());
    }

    res.json(brands);
  } catch (error) {
    console.error('Get brands error:', error);
    res.status(500).json({ error: 'Failed to get brands' });
  }
});

// Get single brand
app.get('/api/brands/:id', (req, res) => {
  try {
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json(brand);
  } catch (error) {
    console.error('Get brand error:', error);
    res.status(500).json({ error: 'Failed to get brand' });
  }
});

// Create brand
app.post('/api/brands', (req, res) => {
  try {
    const { name, meta_ad_library_url, category } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Brand name is required' });
    }

    if (!meta_ad_library_url) {
      return res.status(400).json({ error: 'Meta Ad Library URL is required' });
    }

    // Validate it's a Meta Ad Library URL
    if (!meta_ad_library_url.includes('facebook.com/ads/library')) {
      return res.status(400).json({ error: 'Please provide a valid Meta Ad Library URL' });
    }

    const result = db.prepare(`
      INSERT INTO brands (name, meta_ad_library_url, category)
      VALUES (?, ?, ?)
    `).run(name, meta_ad_library_url.trim(), category || null);

    res.json({
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    console.error('Create brand error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'A brand with this Meta Ad Library URL already exists' });
    }
    res.status(500).json({ error: 'Failed to create brand' });
  }
});

// Update brand
app.put('/api/brands/:id', (req, res) => {
  try {
    const { name, meta_ad_library_url, category, is_active } = req.body;

    // Get existing brand to preserve values not being updated
    const existingBrand = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    if (!existingBrand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Validate URL if provided
    const urlToSave = meta_ad_library_url?.trim() || existingBrand.meta_ad_library_url;
    if (meta_ad_library_url && !meta_ad_library_url.includes('facebook.com/ads/library')) {
      return res.status(400).json({ error: 'Please provide a valid Meta Ad Library URL' });
    }

    const result = db.prepare(`
      UPDATE brands
      SET name = ?, meta_ad_library_url = ?, category = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name ?? existingBrand.name,
      urlToSave,
      category ?? existingBrand.category,
      is_active ?? existingBrand.is_active,
      req.params.id
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Update brand error:', error);
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'A brand with this Meta Ad Library URL already exists' });
    }
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// Delete brand
app.delete('/api/brands/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM brands WHERE id = ?').run(req.params.id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete brand error:', error);
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

// ============================================
// ROUTES - ADS API
// ============================================

// Get all ads (with optional filters)
app.get('/api/ads', (req, res) => {
  try {
    const { is_active, limit = 100, media_type, sort = 'newest' } = req.query;
    // Handle multiple brand_id params (e.g., ?brand_id=1&brand_id=2)
    let brandIds = req.query.brand_id;
    if (brandIds && !Array.isArray(brandIds)) {
      brandIds = [brandIds];
    }

    let sql = 'SELECT ads.*, brands.name as brand_name FROM ads LEFT JOIN brands ON ads.brand_id = brands.id WHERE 1=1';
    const params = [];

    if (brandIds && brandIds.length > 0) {
      const placeholders = brandIds.map(() => '?').join(', ');
      sql += ` AND ads.brand_id IN (${placeholders})`;
      params.push(...brandIds);
    }

    if (is_active !== undefined) {
      sql += ' AND ads.is_active = ?';
      params.push(is_active);
    }

    // Determine sort order
    let orderClause;
    if (sort === 'top_ranked') {
      // For top ranked, we sort by the order they were scraped (which reflects impression rank)
      // Apify returns ads sorted by impressions, so lower id within same scrape = higher rank
      orderClause = 'ORDER BY ads.brand_id, ads.id ASC';
    } else if (sort === 'oldest') {
      orderClause = 'ORDER BY ads.start_date ASC, ads.id ASC';
    } else {
      // newest (default)
      orderClause = 'ORDER BY ads.start_date DESC, ads.id DESC';
    }

    sql += ` ${orderClause} LIMIT ?`;
    params.push(parseInt(limit));

    let ads = db.prepare(sql).all(...params);

    // Filter by media type in JS (since it's stored in raw_data JSON)
    if (media_type === 'video') {
      ads = ads.filter(ad => {
        try {
          const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
          const card = rawData.snapshot?.cards?.[0] || {};
          return !!(card.videoHdUrl || card.videoSdUrl);
        } catch (e) {
          return false;
        }
      });
    } else if (media_type === 'image') {
      ads = ads.filter(ad => {
        try {
          const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
          const card = rawData.snapshot?.cards?.[0] || {};
          return !(card.videoHdUrl || card.videoSdUrl);
        } catch (e) {
          return true; // Assume image if can't parse
        }
      });
    }

    // Return mock data if database is empty (demo mode)
    if (ads.length === 0 && (!brandIds || brandIds.length === 0) && !media_type) {
      return res.json(getMockAds());
    }

    res.json(ads);
  } catch (error) {
    console.error('Get ads error:', error);
    res.status(500).json({ error: 'Failed to get ads' });
  }
});

// Get bookmarked ads (must be before /api/ads/:id to avoid route conflict)
app.get('/api/ads/bookmarked', (req, res) => {
  try {
    const { media_type, sort = 'newest', limit = 100 } = req.query;

    // Determine sort order
    let orderClause;
    if (sort === 'top_ranked') {
      orderClause = 'ORDER BY ads.brand_id, ads.id ASC';
    } else if (sort === 'oldest') {
      orderClause = 'ORDER BY ads.start_date ASC, ads.id ASC';
    } else {
      orderClause = 'ORDER BY ads.start_date DESC, ads.id DESC';
    }

    let sql = `SELECT ads.*, brands.name as brand_name FROM ads LEFT JOIN brands ON ads.brand_id = brands.id WHERE ads.is_bookmarked = 1 ${orderClause} LIMIT ?`;

    let ads = db.prepare(sql).all(parseInt(limit));

    // Filter by media type in JS (since it's stored in raw_data JSON)
    if (media_type === 'video') {
      ads = ads.filter(ad => {
        try {
          const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
          const card = rawData.snapshot?.cards?.[0] || {};
          return !!(card.videoHdUrl || card.videoSdUrl);
        } catch (e) {
          return false;
        }
      });
    } else if (media_type === 'image') {
      ads = ads.filter(ad => {
        try {
          const rawData = ad.raw_data ? JSON.parse(ad.raw_data) : {};
          const card = rawData.snapshot?.cards?.[0] || {};
          return !(card.videoHdUrl || card.videoSdUrl);
        } catch (e) {
          return true;
        }
      });
    }

    res.json(ads);
  } catch (error) {
    console.error('Get bookmarked ads error:', error);
    res.status(500).json({ error: 'Failed to get bookmarked ads' });
  }
});

// Get single ad
app.get('/api/ads/:id', (req, res) => {
  try {
    const ad = db.prepare(`
      SELECT ads.*, brands.name as brand_name
      FROM ads
      LEFT JOIN brands ON ads.brand_id = brands.id
      WHERE ads.id = ?
    `).get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    res.json(ad);
  } catch (error) {
    console.error('Get ad error:', error);
    res.status(500).json({ error: 'Failed to get ad' });
  }
});

// Get ads for a specific brand
app.get('/api/brands/:id/ads', (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const ads = db.prepare(`
      SELECT * FROM ads
      WHERE brand_id = ?
      ORDER BY scraped_at DESC
      LIMIT ?
    `).all(req.params.id, parseInt(limit));

    res.json(ads);
  } catch (error) {
    console.error('Get brand ads error:', error);
    res.status(500).json({ error: 'Failed to get brand ads' });
  }
});

// Toggle bookmark on an ad
app.post('/api/ads/:id/bookmark', (req, res) => {
  try {
    const ad = db.prepare('SELECT is_bookmarked FROM ads WHERE id = ?').get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const newBookmarkState = ad.is_bookmarked ? 0 : 1;
    db.prepare('UPDATE ads SET is_bookmarked = ? WHERE id = ?').run(newBookmarkState, req.params.id);

    res.json({ success: true, is_bookmarked: newBookmarkState });
  } catch (error) {
    console.error('Toggle bookmark error:', error);
    res.status(500).json({ error: 'Failed to toggle bookmark' });
  }
});

// Analyze an ad with Gemini AI
app.post('/api/ads/:id/analyze', async (req, res) => {
  try {
    if (!genAI) {
      return res.status(500).json({ error: 'Gemini API is not configured. Please set GEMINI_API_KEY environment variable.' });
    }

    const ad = db.prepare(`
      SELECT ads.*, brands.name as brand_name
      FROM ads
      LEFT JOIN brands ON ads.brand_id = brands.id
      WHERE ads.id = ?
    `).get(req.params.id);

    if (!ad) {
      return res.status(404).json({ error: 'Ad not found' });
    }

    const result = await analyzeAdWithGemini(ad);

    // Save the analysis to the database
    db.prepare('UPDATE ads SET ai_analysis = ? WHERE id = ?').run(
      JSON.stringify(result),
      req.params.id
    );

    res.json(result);
  } catch (error) {
    console.error('Analyze ad error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze ad' });
  }
});

// ============================================
// ROUTES - SCRAPE JOBS API
// ============================================

// Get all scrape jobs
app.get('/api/scrape-jobs', (req, res) => {
  try {
    const jobs = db.prepare(`
      SELECT scrape_jobs.*, brands.name as brand_name
      FROM scrape_jobs
      LEFT JOIN brands ON scrape_jobs.brand_id = brands.id
      ORDER BY scrape_jobs.created_at DESC
      LIMIT 50
    `).all();

    res.json(jobs);
  } catch (error) {
    console.error('Get scrape jobs error:', error);
    res.status(500).json({ error: 'Failed to get scrape jobs' });
  }
});

// Get single scrape job status
app.get('/api/scrape-jobs/:id', (req, res) => {
  try {
    const job = db.prepare(`
      SELECT scrape_jobs.*, brands.name as brand_name
      FROM scrape_jobs
      LEFT JOIN brands ON scrape_jobs.brand_id = brands.id
      WHERE scrape_jobs.id = ?
    `).get(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Scrape job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Get scrape job error:', error);
    res.status(500).json({ error: 'Failed to get scrape job' });
  }
});

// Start a scrape job for a brand
app.post('/api/brands/:id/scrape', async (req, res) => {
  try {
    if (!apifyClient) {
      return res.status(500).json({ error: 'Apify is not configured. Please set APIFY_TOKEN environment variable.' });
    }

    const brandId = req.params.id;
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId);

    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Create a scrape job record
    const jobResult = db.prepare(`
      INSERT INTO scrape_jobs (brand_id, status, started_at)
      VALUES (?, 'running', CURRENT_TIMESTAMP)
    `).run(brandId);

    const jobId = jobResult.lastInsertRowid;

    // Start the Apify actor run (use start() instead of call() to return immediately)
    try {
      const run = await apifyClient.actor(APIFY_ACTOR_ID).start({
        startUrls: [{ url: brand.meta_ad_library_url }],
        resultsLimit: 20
      });

      // Update job with Apify run ID
      db.prepare('UPDATE scrape_jobs SET apify_run_id = ? WHERE id = ?').run(run.id, jobId);

      res.json({
        success: true,
        job_id: jobId,
        apify_run_id: run.id,
        message: 'Scrape job started'
      });
    } catch (apifyError) {
      // Update job with error status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(apifyError.message, jobId);

      throw apifyError;
    }
  } catch (error) {
    console.error('Start scrape error:', error);
    res.status(500).json({ error: 'Failed to start scrape: ' + error.message });
  }
});

// Check Apify run status and fetch results if complete
app.post('/api/scrape-jobs/:id/check', async (req, res) => {
  try {
    if (!apifyClient) {
      return res.status(500).json({ error: 'Apify is not configured' });
    }

    const job = db.prepare('SELECT * FROM scrape_jobs WHERE id = ?').get(req.params.id);

    if (!job) {
      return res.status(404).json({ error: 'Scrape job not found' });
    }

    if (!job.apify_run_id) {
      return res.status(400).json({ error: 'No Apify run associated with this job' });
    }

    // Get the run status from Apify
    const run = await apifyClient.run(job.apify_run_id).get();

    if (run.status === 'SUCCEEDED') {
      // Fetch the results from the dataset
      const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

      // Save ads to database
      // Note: INSERT OR IGNORE preserves existing ads (including bookmarked ones)
      // New ads are added, existing ads are kept unchanged
      let adsSaved = 0;
      const insertAd = db.prepare(`
        INSERT OR IGNORE INTO ads (
          brand_id, ad_library_id, page_id, page_name, ad_snapshot_url,
          ad_creative_bodies, ad_creative_link_captions, ad_creative_link_titles,
          ad_creative_link_descriptions, is_active, start_date, raw_data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const ad of items) {
        try {
          // Extract body text from snapshot.cards if available
          const cardBody = ad.snapshot?.cards?.[0]?.body || null;
          const cardCaption = ad.snapshot?.cards?.[0]?.caption || ad.snapshot?.caption || null;
          const cardTitle = ad.snapshot?.cards?.[0]?.title || null;
          const cardLinkDescription = ad.snapshot?.cards?.[0]?.linkDescription || null;

          // Format the start date from ISO string or timestamp
          let startDate = null;
          if (ad.startDateFormatted) {
            startDate = ad.startDateFormatted.split('T')[0]; // Get YYYY-MM-DD
          } else if (ad.startDate) {
            // Handle Unix timestamp
            const timestamp = typeof ad.startDate === 'number' ? ad.startDate * 1000 : ad.startDate;
            startDate = new Date(timestamp).toISOString().split('T')[0];
          }

          const result = insertAd.run(
            job.brand_id,
            ad.adArchiveID || ad.adArchiveId || ad.id || null,
            ad.pageID || ad.pageId || null,
            ad.snapshot?.pageName || ad.pageInfo?.page?.name || null,
            ad.snapshot?.cards?.[0]?.originalImageUrl || null,
            cardBody,
            cardCaption,
            cardTitle,
            cardLinkDescription,
            1, // is_active
            startDate,
            JSON.stringify(ad)
          );
          if (result.changes > 0) adsSaved++;
        } catch (insertError) {
          // Expected for duplicate ad_library_ids (INSERT OR IGNORE)
        }
      }

      // Update job status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'completed', ads_found = ?, ads_saved = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(items.length, adsSaved, job.id);

      res.json({
        status: 'completed',
        ads_found: items.length,
        ads_saved: adsSaved
      });
    } else if (run.status === 'FAILED' || run.status === 'ABORTED' || run.status === 'TIMED-OUT') {
      // Update job status
      db.prepare(`
        UPDATE scrape_jobs
        SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(`Apify run ${run.status}`, job.id);

      res.json({
        status: 'failed',
        error: `Apify run ${run.status}`
      });
    } else {
      // Still running
      res.json({
        status: 'running',
        apify_status: run.status
      });
    }
  } catch (error) {
    console.error('Check scrape job error:', error);
    res.status(500).json({ error: 'Failed to check scrape job: ' + error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    apify_configured: !!APIFY_TOKEN,
    gemini_configured: !!GEMINI_API_KEY
  });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log(`Meta Ad Library Scraper running on port ${PORT}`);
});
