import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { hashContent } from './articleUtils.js';

export class SemanticChunker {
  constructor({ chunkSize = 2400, chunkOverlap = 320 } = {}) {
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      separators: ['\n\n', '\n', '. ', ' ', '']
    });
  }

  async chunkArticle({ title = '', content = '', canonicalUrl = '', contentHash = '', sourceId = '', publishedAt = null }) {
    const sourceText = [title.trim(), content.trim()].filter(Boolean).join('\n\n');
    if (!sourceText) {
      return [];
    }

    const chunks = await this.splitter.splitText(sourceText);

    return chunks.map((chunkText, index) => {
      const chunkHash = hashContent(chunkText);
      const chunkId = hashContent(`${canonicalUrl}|${contentHash}|${index}|${chunkHash}`).slice(0, 32);

      return {
        chunkId,
        chunkIndex: index,
        chunkText,
        chunkHash,
        canonicalUrl,
        contentHash,
        sourceId,
        publishedAt
      };
    });
  }
}
