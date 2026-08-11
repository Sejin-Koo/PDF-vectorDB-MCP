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

/** Qdrant scroll — 필터 조건으로 포인트를 페이지네이션 없이 모두 가져옴 */
async function qdrantScroll(collection, filter, limit = 1000) {
  const points = [];
  let offset = null;
  for (let guard = 0; guard < 20; guard++) {
    const body = { limit: Math.min(limit, 500), with_payload: true, with_vector: false };
    if (filter) body.filter = filter;
    if (offset !== null) body.offset = offset;
    const res = await fetch(
      `${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": QDRANT_API_KEY },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      throw new Error(`Qdrant scroll 실패 (${res.status}): ${await res.text()}`);
    }
    const data = await res.json();
    points.push(...data.result.points);
    offset = data.result.next_page_offset ?? null;
    if (offset === null || points.length >= limit) break;
  }
  return points;
}

/**
 * 조문 번호 표기를 정규화한다.
 * "56", "제56조", "제 56 조", "56의2", "제8조의 2", "8-2" → "제56조" / "제8조의2"
 */
function normalizeArticleNo(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^부\s*칙$/.test(s)) return "부칙";
  const m = s.match(/(\d+)\s*조?\s*(?:의|-)\s*(\d+)/);
  if (m) return `제${m[1]}조의${m[2]}`;
  const m2 = s.match(/(\d+)/);
  return m2 ? `제${m2[1]}조` : null;
}

/** 정규화된 조문번호에 대응하는 표기 변형(저장 시점마다 다를 수 있음) */
function articleVariants(no) {
  if (!no) return [];
  const v = new Set([no]);
  const m = no.match(/^제(\d+)조의(\d+)$/);
  if (m) {
    v.add(`제${m[1]}조의 ${m[2]}`);
    v.add(`제${m[1]}조의${m[2]}`);
    v.add(`제 ${m[1]} 조의 ${m[2]}`);
  } else {
    const n = no.match(/^제(\d+)조$/);
    if (n) v.add(`제 ${n[1]} 조`);
  }
  return [...v];
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
          const full = payload.text || "";
          const LIMIT = 700;
          const snippet = full.slice(0, LIMIT).replace(/\n/g, " ");
          const truncated = full.length > LIMIT;
          // 사규(조문 단위 저장) 컬렉션이면 출처에 조문 번호·표제를 함께 표시
          const art = payload.article_no
            ? ` ${payload.article_no}${payload.article_title ? `(${payload.article_title})` : ""}`
            : "";
          const source = payload.article_no
            ? `출처: ${payload.doc_title || payload.book_title}${art}`
            : `출처: ${payload.book_title} (p.${payload.page_start}~${payload.page_end})`;
          const tail = truncated
            ? `...\n(발췌 ${LIMIT}자 / 전체 ${full.length}자 — 전문은 get_rule_article로 조회)`
            : "";
          return (
            `${rank + 1}위 (관련도: ${r.relevance_score.toFixed(3)})\n` +
            `${source}\n` +
            `내용: ${snippet}${tail}`
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

    server.registerTool(
      "get_rule_article",
      {
        title: "조문 번호로 규정 원문 조회",
        description:
          "조문 번호로 사규·정관의 조문 원문을 **정확히 일치** 방식으로 조회합니다(의미검색 아님). " +
          "search_book_library는 유사도 기반이라 '제56조를 보여줘' 같은 요청에 엉뚱한 조문이 나오거나 " +
          "조각 청크만 걸릴 수 있으므로, 조문 번호를 아는 경우에는 이 도구를 쓰세요. " +
          "article_no를 생략하면 해당 문서의 조문 목차(조 번호 + 표제 전체 목록)를 반환하므로, " +
          "'이 규정에 무슨 조문이 있나' '몇 조까지 있나'를 확인할 때도 사용합니다. " +
          "번호 표기는 '제56조', '56', '8조의2', '제8조의 2' 등 어떤 형태로 넣어도 정규화됩니다. " +
          "조문 단위로 저장된 컬렉션(ponylink_rules)에서만 동작하며, 책 컬렉션에는 조문 메타데이터가 없습니다.",
        inputSchema: {
          collection: z
            .string()
            .default("ponylink_rules")
            .describe("컬렉션 이름 (기본 ponylink_rules — 포니링크 사규·정관)"),
          doc_title: z
            .string()
            .optional()
            .describe(
              "문서명 (예: 정관, 취업규칙, 징계규정). 부분일치로 찾습니다. 생략하면 컬렉션 전체에서 같은 조 번호를 모두 반환"
            ),
          article_no: z
            .string()
            .optional()
            .describe(
              "조문 번호. 생략하면 해당 문서의 조문 목차를 반환합니다. 예: '제56조', '56', '8조의2', '부칙'"
            ),
          context: z
            .number()
            .int()
            .min(0)
            .max(5)
            .default(0)
            .describe("앞뒤로 함께 반환할 인접 조문 수 (기본 0)"),
        },
      },
      async ({ collection, doc_title, article_no, context }) => {
        const coll = collection || "ponylink_rules";
        const ctx = context ?? 0;
        const all = await qdrantScroll(coll, null, 5000);
        const withArticles = all.filter((p) => p.payload && p.payload.article_no !== undefined);

        if (withArticles.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `'${coll}' 컬렉션에는 조문(article_no) 메타데이터가 없습니다. ` +
                  `이 도구는 조문 단위로 저장된 사규 컬렉션(ponylink_rules)에서만 동작합니다. ` +
                  `대신 search_book_library로 의미검색을 사용하세요.`,
              },
            ],
          };
        }

        // 문서 필터 (부분일치)
        let scoped = withArticles;
        if (doc_title) {
          const needle = doc_title.replace(/\s/g, "");
          scoped = withArticles.filter((p) =>
            String(p.payload.doc_title || "").replace(/\s/g, "").includes(needle)
          );
          if (scoped.length === 0) {
            const docs = [...new Set(withArticles.map((p) => p.payload.doc_title))].sort();
            return {
              content: [
                {
                  type: "text",
                  text:
                    `'${doc_title}'과(와) 일치하는 문서를 찾지 못했습니다.\n\n` +
                    `이 컬렉션의 문서 목록:\n- ${docs.join("\n- ")}`,
                },
              ],
            };
          }
        }

        // 정렬 키: 조 번호 → 가지 번호
        const sortKey = (p) => {
          const a = String(p.payload.article_no || "");
          if (a === "부칙") return [99999, 0];
          const m = a.match(/^제(\d+)조(?:의(\d+))?$/);
          return m ? [parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0] : [99998, 0];
        };
        const byDoc = {};
        for (const p of scoped) {
          const d = p.payload.doc_title || "(문서명 없음)";
          (byDoc[d] = byDoc[d] || []).push(p);
        }
        for (const d of Object.keys(byDoc)) {
          byDoc[d].sort((x, y) => {
            const a = sortKey(x), b = sortKey(y);
            return a[0] - b[0] || a[1] - b[1];
          });
        }

        // article_no 생략 → 조문 목차 반환
        if (!article_no) {
          const blocks = Object.entries(byDoc).map(([d, ps]) => {
            const lines = ps
              .filter((p) => p.payload.article_no)
              .map(
                (p) =>
                  `  ${p.payload.article_no}${
                    p.payload.article_title ? ` (${p.payload.article_title})` : ""
                  }${p.payload.chapter ? `  [${p.payload.chapter}]` : ""}`
              );
            return `■ ${d} — 조문 ${lines.length}개\n${lines.join("\n")}`;
          });
          return { content: [{ type: "text", text: blocks.join("\n\n") }] };
        }

        const norm = normalizeArticleNo(article_no);
        const variants = new Set(articleVariants(norm).map((v) => v.replace(/\s/g, "")));
        const hits = [];
        for (const [d, ps] of Object.entries(byDoc)) {
          ps.forEach((p, i) => {
            const a = String(p.payload.article_no || "").replace(/\s/g, "");
            if (variants.has(a)) {
              const from = Math.max(0, i - ctx);
              const to = Math.min(ps.length - 1, i + ctx);
              hits.push({ doc: d, main: p, neighbors: ps.slice(from, to + 1) });
            }
          });
        }

        if (hits.length === 0) {
          const cand = Object.entries(byDoc)
            .map(([d, ps]) => {
              const nos = ps.map((p) => p.payload.article_no).filter(Boolean);
              return `- ${d}: ${nos.length}개 조문 (${nos[0] || "-"} ~ ${nos[nos.length - 1] || "-"})`;
            })
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text:
                  `${doc_title ? `'${doc_title}'에서 ` : ""}${norm || article_no}을(를) 찾지 못했습니다.\n\n` +
                  `조회 범위:\n${cand}\n\n` +
                  `article_no를 생략하고 호출하면 조문 목차 전체를 볼 수 있습니다.`,
              },
            ],
          };
        }

        const out = hits.map((h) => {
          const head = `■ ${h.doc} ${h.main.payload.article_no}${
            h.main.payload.article_title ? `(${h.main.payload.article_title})` : ""
          }`;
          const meta = [
            h.main.payload.chapter,
            h.main.payload.section,
            h.main.payload.effective_date ? `시행 ${h.main.payload.effective_date}` : null,
            h.main.payload.revision,
          ]
            .filter(Boolean)
            .join(" | ");
          const bodies = h.neighbors
            .map((p) => (p.id === h.main.id ? p.payload.text : `[인접 조문]\n${p.payload.text}`))
            .join("\n\n");
          return `${head}${meta ? `\n${meta}` : ""}\n\n${bodies}`;
        });

        return {
          content: [
            {
              type: "text",
              text: `조문 조회 결과 ${hits.length}건 (컬렉션: ${coll})\n\n${out.join("\n\n────────\n\n")}`,
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
