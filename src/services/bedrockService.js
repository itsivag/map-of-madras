import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand
} from '@aws-sdk/client-bedrock-runtime';
import { parseSemanticExtraction } from './semanticSchema.js';

async function readBody(body) {
  if (!body) {
    return '';
  }

  if (typeof body === 'string') {
    return body;
  }

  if (typeof body.transformToString === 'function') {
    return body.transformToString();
  }

  if (typeof body.transformToByteArray === 'function') {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes).toString('utf8');
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer).toString('utf8');
  }

  return Buffer.from(body).toString('utf8');
}

function extractEmbedding(payload) {
  const vector =
    payload.embedding ||
    payload.outputEmbedding ||
    payload.vector ||
    payload?.embeddings?.[0] ||
    payload?.results?.[0]?.embedding;

  if (!Array.isArray(vector)) {
    throw new Error('Bedrock embedding response did not include a vector.');
  }

  return vector.map((value) => Number(value));
}

function extractJsonFromFence(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }

  return match[1].trim();
}

function extractBalancedJsonSnippet(text) {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

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

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function extractJsonObject(text) {
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

  const preview = text.trim().slice(0, 240).replace(/\s+/g, ' ');
  throw new Error(
    preview
      ? `MiniMax response did not include JSON output. Raw preview: ${preview}`
      : 'MiniMax response did not include JSON output.'
  );
}

function extractConverseText(response) {
  const content = response?.output?.message?.content || [];
  return content
    .map((entry) => entry?.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildExtractionPrompt({ article, taxonomyCandidates, evidenceChunks }) {
  const taxonomyBlock = taxonomyCandidates
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.category} | score=${candidate.score?.toFixed?.(3) || candidate.score}\n${candidate.title}\n${candidate.document}`
    )
    .join('\n\n');

  const evidenceBlock = evidenceChunks
    .map(
      (chunk) =>
        `chunkId=${chunk.chunkId} supports=${chunk.supports.join(',')}\n${chunk.chunkText}`
    )
    .join('\n\n');

  return [
    'Extract a single structured Chennai crime incident from the article evidence.',
    'Return JSON only with the exact keys:',
    JSON.stringify(
      {
        isCrimeEvent: true,
        category: 'murder',
        subcategory: 'mob beating',
        occurredAt: '2026-03-13T05:53:54.000Z',
        locationText: 'Chennai Airport',
        locationPrecision: 'locality',
        evidence: [{ chunkId: 'chunk-1', supports: 'offense' }],
        confidence: 0.91,
        rejectionReason: null
      },
      null,
      2
    ),
    `Allowed categories: murder, rape, assault, robbery/theft, kidnapping, fraud/scam, drug offense, other, not-a-crime-event.`,
    `Article title: ${article.title}`,
    `Article publishedAt: ${article.publishedAt || 'unknown'}`,
    'Shortlisted taxonomy candidates:',
    taxonomyBlock || 'None',
    'Evidence chunks:',
    evidenceBlock || 'None'
  ].join('\n\n');
}

function buildRepairPrompt({ prompt, previousRawText, errorMessage }) {
  return [
    prompt,
    'Your previous response was invalid.',
    `Parsing error: ${errorMessage}`,
    'Return exactly one valid JSON object.',
    'Do not use markdown fences.',
    'Do not add commentary.',
    'If unsure, still return the required JSON object with the best supported values.',
    'Previous response:',
    previousRawText || '(empty response)'
  ].join('\n\n');
}

export class BedrockSemanticService {
  constructor({
    client = null,
    region = '',
    embedModelId = 'amazon.titan-embed-text-v2:0',
    extractionModelId = 'minimax.minimax-m2.1',
    promptVersion = 'semantic-v1'
  } = {}) {
    this.client = client || (region ? new BedrockRuntimeClient({ region }) : null);
    this.embedModelId = embedModelId;
    this.extractionModelId = extractionModelId;
    this.promptVersion = promptVersion;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async embedText(text) {
    if (!this.client) {
      throw new Error('Bedrock client is not configured.');
    }

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.embedModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: text,
          normalize: true
        })
      })
    );

    const payload = JSON.parse(await readBody(response.body));
    return extractEmbedding(payload);
  }

  async embedTexts(texts) {
    const vectors = [];

    for (const text of texts) {
      vectors.push(await this.embedText(text));
    }

    return vectors;
  }

  async runExtractionPrompt(prompt) {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.extractionModelId,
        system: [
          {
            text: [
              'You classify and extract Chennai crime incidents from news articles.',
              'Do not invent facts.',
              'If the article is not a discrete crime event, return category="not-a-crime-event".',
              'Use only the provided evidence chunks for evidence ids.',
              'Return valid JSON only.'
            ].join(' ')
          }
        ],
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }]
          }
        ],
        inferenceConfig: {
          maxTokens: 1200,
          temperature: 0.1,
          topP: 0.9
        }
      })
    );

    return extractConverseText(response);
  }

  async extractIncident({ article, taxonomyCandidates, evidenceChunks }) {
    if (!this.client) {
      throw new Error('Bedrock client is not configured.');
    }

    const prompt = buildExtractionPrompt({ article, taxonomyCandidates, evidenceChunks });
    let rawText = await this.runExtractionPrompt(prompt);
    let parsed;

    try {
      parsed = parseSemanticExtraction(extractJsonObject(rawText));
    } catch (error) {
      rawText = await this.runExtractionPrompt(
        buildRepairPrompt({
          prompt,
          previousRawText: rawText,
          errorMessage: error.message
        })
      );
      parsed = parseSemanticExtraction(extractJsonObject(rawText));
    }

    return {
      modelId: this.extractionModelId,
      promptVersion: this.promptVersion,
      rawText,
      parsed
    };
  }
}
