import { describe, expect, it, vi } from 'vitest';
import { BedrockSemanticService } from '../../src/services/bedrockService.js';

function stringBody(value) {
  return {
    async transformToString() {
      return value;
    }
  };
}

describe('bedrock semantic service', () => {
  it('embeds text and parses structured MiniMax extraction output', async () => {
    const send = vi.fn(async (command) => {
      if (command.constructor.name === 'InvokeModelCommand') {
        return {
          body: stringBody(
            JSON.stringify({
              embedding: [0.11, 0.22, 0.33]
            })
          )
        };
      }

      return {
        output: {
          message: {
            content: [
              {
                text: JSON.stringify({
                  isCrimeEvent: true,
                  category: 'murder',
                  subcategory: 'mob beating',
                  occurredAt: '2026-03-13T05:53:54.000Z',
                  locationText: 'Meenambakkam',
                  locationPrecision: 'locality',
                  evidence: [
                    { chunkId: 'chunk-1', supports: 'offense' },
                    { chunkId: 'chunk-2', supports: 'location' }
                  ],
                  confidence: 0.94,
                  rejectionReason: null
                })
              }
            ]
          }
        }
      };
    });

    const service = new BedrockSemanticService({
      client: { send },
      embedModelId: 'amazon.titan-embed-text-v2:0',
      extractionModelId: 'minimax.minimax-m2.1',
      promptVersion: 'semantic-v1'
    });

    const vector = await service.embedText('Mob kills van driver in Chennai');
    const extraction = await service.extractIncident({
      article: {
        title: 'Mob kills van driver in Chennai',
        publishedAt: '2026-03-13T05:53:54.000Z'
      },
      taxonomyCandidates: [
        {
          category: 'murder',
          title: 'Murder',
          document: 'Intentional killing.',
          score: 0.98
        }
      ],
      evidenceChunks: [
        {
          chunkId: 'chunk-1',
          supports: ['offense'],
          chunkText: 'Witnesses said the mob beat him to death near Meenambakkam.'
        }
      ]
    });

    expect(vector).toEqual([0.11, 0.22, 0.33]);
    expect(extraction.modelId).toBe('minimax.minimax-m2.1');
    expect(extraction.parsed.category).toBe('murder');
    expect(extraction.parsed.locationText).toBe('Meenambakkam');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries when the first MiniMax response is not valid JSON', async () => {
    let extractionCallCount = 0;
    const send = vi.fn(async (command) => {
      if (command.constructor.name === 'InvokeModelCommand') {
        return {
          body: stringBody(
            JSON.stringify({
              embedding: [0.11, 0.22, 0.33]
            })
          )
        };
      }

      extractionCallCount += 1;

      if (extractionCallCount === 1) {
        return {
          output: {
            message: {
              content: [{ text: 'This is a murder case in Chennai. Category: murder.' }]
            }
          }
        };
      }

      return {
        output: {
          message: {
            content: [
              {
                text: '```json\n{"isCrimeEvent":true,"category":"murder","subcategory":"mob beating","occurredAt":"2026-03-13T05:53:54.000Z","locationText":"Broadway","locationPrecision":"locality","evidence":[{"chunkId":"chunk-1","supports":"offense"},{"chunkId":"chunk-1","supports":"location"}],"confidence":0.94,"rejectionReason":null}\n```'
              }
            ]
          }
        }
      };
    });

    const service = new BedrockSemanticService({
      client: { send },
      embedModelId: 'amazon.titan-embed-text-v2:0',
      extractionModelId: 'minimax.minimax-m2.1',
      promptVersion: 'semantic-v1'
    });

    const extraction = await service.extractIncident({
      article: {
        title: 'Mob kills van driver in Chennai',
        publishedAt: '2026-03-13T05:53:54.000Z'
      },
      taxonomyCandidates: [],
      evidenceChunks: [
        {
          chunkId: 'chunk-1',
          supports: ['offense', 'location'],
          chunkText: 'Witnesses said the mob beat him to death near Broadway.'
        }
      ]
    });

    expect(extraction.parsed.category).toBe('murder');
    expect(extraction.parsed.locationText).toBe('Broadway');
    expect(extractionCallCount).toBe(2);
  });
});
