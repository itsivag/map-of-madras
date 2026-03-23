import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

const ALLOWED_CATEGORIES = [
  'murder',
  'rape', 
  'assault',
  'robbery/theft',
  'kidnapping',
  'fraud/scam',
  'drug offense',
  'other',
  'not-a-crime-event'
];

const DEFAULT_PROMPT = `You are a crime data extractor for Chennai, India news.

Your task: Analyze the news article and extract structured incident data.

EXTRACTION RULES:
1. Only extract if this is a DISCRETE crime incident (specific event with victim, location, time)
2. Return "not-a-crime-event" for: editorials, general news, court proceedings, appeals, statistics, policy announcements
3. The incident must have occurred in or near Chennai, Tamil Nadu
4. Be precise with location - extract the specific neighborhood, street, or landmark
5. For occurredAt: use the incident date mentioned in article, NOT the publication date

ARTICLE:
Title: {{title}}
Content: {{content}}

Respond with VALID JSON ONLY (no markdown, no commentary):
{
  "isCrimeEvent": boolean,
  "category": "murder|rape|assault|robbery/theft|kidnapping|fraud/scam|drug offense|other|not-a-crime-event",
  "subcategory": "string or null (e.g., 'chain snatching', 'cyber fraud', 'domestic violence')",
  "locationText": "specific Chennai locality/neighborhood/street",
  "locationPrecision": "exact|locality|area|city",
  "occurredAt": "ISO 8601 datetime string or null",
  "confidence": 0.0-1.0,
  "summary": "2-3 sentence objective description of the incident",
  "rejectionReason": "null or brief reason if not a crime event"
}

CONFIDENCE GUIDE:
- 0.9-1.0: Clear crime report with all details present
- 0.7-0.89: Likely crime but some details unclear
- 0.5-0.69: Possible crime but significant uncertainty
- Below 0.5: Set isCrimeEvent to false`;

function truncateText(text, maxLength = 6000) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  // Try to truncate at a sentence boundary
  const truncated = text.slice(0, maxLength);
  const lastSentence = truncated.lastIndexOf('. ');
  if (lastSentence > maxLength * 0.8) {
    return truncated.slice(0, lastSentence + 1);
  }
  return truncated + '...';
}

function extractJsonFromFence(text) {
  const match = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
  return match ? match[1].trim() : null;
}

function extractBalancedJsonSnippet(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonResponse(text) {
  const candidates = [
    text.trim(),
    extractJsonFromFence(text),
    extractBalancedJsonSnippet(text)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  
  throw new Error(`Invalid JSON response: ${text.slice(0, 200)}...`);
}

function normalizeCategory(category) {
  if (!category) return 'other';
  const normalized = category.toLowerCase().trim();
  if (ALLOWED_CATEGORIES.includes(normalized)) {
    return normalized;
  }
  // Map common variations
  const mappings = {
    'robbery': 'robbery/theft',
    'theft': 'robbery/theft',
    'burglary': 'robbery/theft',
    'chain snatching': 'robbery/theft',
    'fraud': 'fraud/scam',
    'scam': 'fraud/scam',
    'cheating': 'fraud/scam',
    'drugs': 'drug offense',
    'narcotics': 'drug offense',
    'sexual assault': 'rape',
    'molestation': 'assault',
    'not a crime': 'not-a-crime-event',
    'notacrime': 'not-a-crime-event',
    'none': 'not-a-crime-event'
  };
  return mappings[normalized] || 'other';
}

function normalizeExtraction(raw) {
  const extraction = {
    isCrimeEvent: Boolean(raw.isCrimeEvent),
    category: normalizeCategory(raw.category),
    subcategory: raw.subcategory || null,
    locationText: raw.locationText || null,
    locationPrecision: raw.locationPrecision || 'city',
    occurredAt: raw.occurredAt || null,
    confidence: Math.max(0, Math.min(1, parseFloat(raw.confidence) || 0)),
    summary: raw.summary || null,
    rejectionReason: raw.rejectionReason || null
  };

  // Validate and fix
  if (!extraction.isCrimeEvent || extraction.category === 'not-a-crime-event') {
    extraction.isCrimeEvent = false;
    extraction.category = 'not-a-crime-event';
  }

  // Parse occurredAt to valid ISO string
  if (extraction.occurredAt) {
    try {
      const date = new Date(extraction.occurredAt);
      if (!isNaN(date.getTime())) {
        extraction.occurredAt = date.toISOString();
      } else {
        extraction.occurredAt = null;
      }
    } catch {
      extraction.occurredAt = null;
    }
  }

  return extraction;
}

export class SimpleExtractionService {
  constructor({ 
    bedrockClient = null, 
    modelId = 'minimax.minimax-m2.1',
    maxTokens = 1200,
    temperature = 0.1,
    topP = 0.9,
    maxContentLength = 6000
  } = {}) {
    this.client = bedrockClient;
    this.modelId = modelId;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.topP = topP;
    this.maxContentLength = maxContentLength;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  buildPrompt(article) {
    const title = String(article.title || '');
    const content = truncateText(String(article.content || ''), this.maxContentLength);
    
    return DEFAULT_PROMPT
      .replace('{{title}}', title)
      .replace('{{content}}', content);
  }

  async extractIncident(article) {
    if (!this.client) {
      throw new Error('Bedrock client is not configured');
    }

    console.log(`[SimpleExtraction] Starting extraction for: ${article.title?.slice(0, 50)}...`);
    
    const prompt = this.buildPrompt(article);

    try {
      const response = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [
            {
              text: 'You are a precise crime data extractor for Chennai news. Return only valid JSON. Do not invent facts not present in the article.'
            }
          ],
          messages: [
            {
              role: 'user',
              content: [{ text: prompt }]
            }
          ],
          inferenceConfig: {
            maxTokens: this.maxTokens,
            temperature: this.temperature,
            topP: this.topP
          }
        })
      );

      const rawText = response?.output?.message?.content
        ?.map(item => item?.text || '')
        ?.join('\n')
        ?.trim() || '';

      if (!rawText) {
        throw new Error('Empty response from LLM');
      }

      const parsed = parseJsonResponse(rawText);
      const extraction = normalizeExtraction(parsed);

      console.log(`[SimpleExtraction] Extraction complete: isCrimeEvent=${extraction.isCrimeEvent}, category=${extraction.category}, confidence=${extraction.confidence}`);

      return {
        success: true,
        extraction,
        rawText,
        modelId: this.modelId
      };
    } catch (error) {
      console.error(`[SimpleExtraction] Extraction failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        extraction: {
          isCrimeEvent: false,
          category: 'not-a-crime-event',
          confidence: 0,
          rejectionReason: `Extraction failed: ${error.message}`
        },
        rawText: null,
        modelId: this.modelId
      };
    }
  }
}
