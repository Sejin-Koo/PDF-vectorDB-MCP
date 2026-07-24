import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const QDRANT_URL = process.env.QDRANT_URL; // 예: https://xxxx.aws.cloud.qdrant.io:6333 (포트 없이 443도 가능)
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

const EMBED_MODEL = "voyage-3.5";
const OUTPUT_DIMENSION = 1024;
const RERANK_MODEL = "rerank-2.5";
const RETRIEVE_MULTIPLIER = 4;

/** Voyage AI로 쿼리 텍스트를 임베딩 벡터로 변환 */
async function embedQuery(text) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: [text],
      model: EMBED_MODEL,
      input_type: "query",
      output_dimension: OUTPUT_DIMENSION,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage embed 실패 (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

/** Voyage AI rerank로 검색 결과 재정렬 */
async function rerankDocuments(query, documents, topK) {
  const res = await fetch("https://api.voyageai.com/v1/rerank", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      documents,
      model: RERANK_MODEL,
      top_k: topK,
    }),
  });
  if (!res.ok) {
    throw new Error(`Voyage rerank 실패 (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.data; // [{ index, relevance_score }, ...]
}

/** Qdrant 컬렉션에서 벡터 검색 (신버전 Query API 사용) */
async function qdrantQuery(collection, vector, limit) {
  const res = await fetch(
    `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": QDRANT_API_KEY,
      },
      body: JSON.stringify({
        query: vector,
        limit,
        with_payload: true,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`Qdrant 검색 실패 (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.result.points; // [{ id, score, payload }, ...]
}

/** 전체 컬렉션 목록 + 각 컬렉션의 포인트 개수 조회 */
async function listCollections() {
  const listRes = await fetch(`${QDRANT_URL}/collections`, {
    headers: { "api-key": QDRANT_API_KEY },
  });
  if (!listRes.ok) {
    throw new Error(`컬렉션 목록 조회 실패 (${listRes.status}): ${await listRes.text()}`);
  }
  const listData = await listRes.json();
  const names = listData.result.collections.map((c) => c.name);

  const details = await Promise.all(
    names.map(async (name) => {
      const infoRes = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`, {
        headers: { "api-key": QDRANT_API_KEY },
      });
      const infoData = await infoRes.json();
      return {
        name,
        points_count: infoData.result?.points_count ?? "알 수 없음",
      };
    })
  );
  return details;
}

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "list_book_collections",
      {
        title: "지식베이스 컬렉션 목록 조회",
        description:
          "현재 Qdrant 지식베이스에 등록된 컬렉션(주제 폴더) 목록과 각 컬렉션에 저장된 청크 개수를 반환합니다. " +
          "search_book_library 도구를 사용하기 전에 어떤 컬렉션이 있는지 확인할 때 사용합니다.",
        inputSchema: {},
      },
      async () => {
        const collections = await listCollections();
        const lines = collections.map(
          (c) => `- ${c.name} (저장된 청크 수: ${c.points_count})`
        );
        return {
          content: [
            {
              type: "text",
              text: `등록된 지식베이스 컬렉션:\n${lines.join("\n")}`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "search_book_library",
      {
        title: "지식베이스 도서 검색",
        description:
          "포니링크 IT사업본부의 벡터 지식베이스(M&A 실무서, 영문계약 실무서, 가치평가 서적 등)에서 " +
          "의미 기반 검색을 수행합니다. 자연어 질문을 그대로 입력하면 관련도 높은 순으로 " +
          "책 제목, 페이지 범위, 발췌문을 반환합니다. 어떤 컬렉션이 있는지 모르면 " +
          "list_book_collections를 먼저 호출하세요.",
        inputSchema: {
          collection: z
            .string()
            .describe(
              "검색할 컬렉션 이름 (예: mna_playbook, contract_playbook, valuation_playbook)"
            ),
          query: z.string().describe("자연어 검색어 또는 질문"),
          top_k: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("반환할 결과 개수 (기본 5)"),
        },
      },
      async ({ collection, query, top_k }) => {
        const topK = top_k ?? 5;
        const queryVector = await embedQuery(query);
        const retrieved = await qdrantQuery(collection, queryVector, topK * RETRIEVE_MULTIPLIER);

        if (retrieved.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `'${collection}' 컬렉션에서 검색 결과가 없습니다. 컬렉션 이름을 확인해주세요.`,
              },
            ],
          };
        }

        const documents = retrieved.map((r) => r.payload?.text || "");
        const reranked = await rerankDocuments(query, documents, topK);

        const resultBlocks = reranked.map((r, rank) => {
          const original = retrieved[r.index];
          const payload = original.payload || {};
          const snippet = (payload.text || "").slice(0, 400).replace(/\n/g, " ");
          return (
            `${rank + 1}위 (관련도: ${r.relevance_score.toFixed(3)})\n` +
            `출처: ${payload.book_title} (p.${payload.page_start}~${payload.page_end})\n` +
            `내용: ${snippet}...`
          );
        });

        return {
          content: [
            {
              type: "text",
              text: `검색어: "${query}" (컬렉션: ${collection})\n\n${resultBlocks.join("\n\n")}`,
            },
          ],
        };
      }
    );
  },
  {},
  { basePath: "/api", maxDuration: 60, verboseLogs: true }
);

export { handler as GET, handler as POST, handler as DELETE };
