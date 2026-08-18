import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

const QDRANT_URL = process.env.QDRANT_URL; // 예: https://xxxx.aws.cloud.qdrant.io:6333 (포트 없이 443도 가능)
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

const EMBED_MODEL = "voyage-3.5";
const OUTPUT_DIMENSION = 1024;
const RERANK_MODEL = "rerank-2.5";
const RETRIEVE_MULTIPLIER = 4;

// search_book_library 발췌 기본 길이. max_chars=0으로 호출하면 자르지 않는다.
const DEFAULT_SNIPPET_CHARS = 700;
// get_chunk_text가 한 번에 돌려줄 수 있는 본문 총량 상한(응답 폭주 방지).
const MAX_TOTAL_CHARS = 60000;

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

/** payload에서 문서명을 꺼낸다 (사규는 doc_title, 책은 book_title) */
function payloadDocTitle(payload) {
  return String(payload?.doc_title || payload?.book_title || "");
}

/** 공백을 무시한 부분일치 */
function looseIncludes(haystack, needle) {
  return String(haystack).replace(/\s/g, "").includes(String(needle).replace(/\s/g, ""));
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
          "list_book_collections를 먼저 호출하세요. " +
          "발췌문은 기본 700자에서 잘리며, 표·목록·질의회신이 중간에서 잘려 보이면 " +
          "max_chars=0으로 다시 호출해 청크 전문을 받으세요(같은 검색어로 재시도하는 것은 해결책이 아닙니다).",
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
          max_chars: z
            .number()
            .int()
            .min(0)
            .max(20000)
            .default(DEFAULT_SNIPPET_CHARS)
            .describe(
              "각 결과 발췌문의 최대 글자 수 (기본 700). 0을 넣으면 자르지 않고 청크 전문을 " +
                "줄바꿈까지 보존해 반환합니다. 결과가 '...'로 끝나면 0으로 재호출하세요"
            ),
        },
      },
      async ({ collection, query, top_k, max_chars }) => {
        const topK = top_k ?? 5;
        const LIMIT =
          max_chars === undefined || max_chars === null ? DEFAULT_SNIPPET_CHARS : max_chars;
        const noLimit = LIMIT === 0;
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

        let budget = MAX_TOTAL_CHARS;
        const resultBlocks = reranked.map((r, rank) => {
          const original = retrieved[r.index];
          const payload = original.payload || {};
          const full = payload.text || "";
          // 전문 모드에서는 줄바꿈을 유지해야 표·목록이 읽힌다.
          let body;
          let tail = "";
          if (noLimit) {
            const room = Math.max(0, budget);
            body = full.slice(0, room);
            budget -= body.length;
            if (full.length > body.length) {
              tail = `\n(응답 총량 상한 ${MAX_TOTAL_CHARS}자에 걸려 이 청크는 ${body.length}/${full.length}자만 표시됨 — top_k를 줄이거나 get_chunk_text로 개별 조회하세요)`;
            }
          } else {
            body = full.slice(0, LIMIT).replace(/\n/g, " ");
            if (full.length > LIMIT) {
              const locator = payload.article_no
                ? `get_rule_article(collection="${collection}", article_no="${payload.article_no}")`
                : `max_chars=0으로 재호출하거나 get_chunk_text(collection="${collection}", doc_title="${payloadDocTitle(payload)}", page_start=${payload.page_start})`;
              tail = `...\n(발췌 ${LIMIT}자 / 전체 ${full.length}자 — 전문: ${locator})`;
            }
          }
          // 사규(조문 단위 저장) 컬렉션이면 출처에 조문 번호·표제를 함께 표시
          const art = payload.article_no
            ? ` ${payload.article_no}${payload.article_title ? `(${payload.article_title})` : ""}`
            : "";
          const source = payload.article_no
            ? `출처: ${payloadDocTitle(payload)}${art}`
            : `출처: ${payload.book_title} (p.${payload.page_start}~${payload.page_end})`;
          return (
            `${rank + 1}위 (관련도: ${r.relevance_score.toFixed(3)})\n` +
            `${source}\n` +
            `내용: ${body}${tail}`
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
      "get_chunk_text",
      {
        title: "청크 전문 조회 (절단 없이)",
        description:
          "책·해설서 컬렉션에서 특정 청크의 본문 전체를 자르지 않고 반환합니다. " +
          "search_book_library 결과가 '...'로 끝나 표·목록·질의회신이 중간에서 잘렸을 때, " +
          "그 결과에 표시된 문서명과 시작 페이지(p.앞 숫자)를 그대로 넣어 호출하세요. " +
          "page_start(정확 일치), page_from~page_to(범위), chunk_index 중 하나로 지정할 수 있고, " +
          "아무 조건도 주지 않으면 해당 문서에 어떤 페이지 청크가 있는지 목록을 반환합니다. " +
          "조문 단위로 저장된 사규 컬렉션(ponylink_rules)은 이 도구 대신 get_rule_article이 더 정확합니다.",
        inputSchema: {
          collection: z
            .string()
            .describe("컬렉션 이름 (예: krx_listing_disclosure, mna_playbook, valuation_playbook)"),
          doc_title: z
            .string()
            .optional()
            .describe(
              "문서명 (부분일치, 공백 무시). 예: '코스닥시장 공시·상장관리 해설'. 생략하면 컬렉션 전체에서 찾습니다"
            ),
          page_start: z
            .number()
            .int()
            .optional()
            .describe("청크의 시작 페이지 (search_book_library 결과의 'p.353~355'에서 353)"),
          page_from: z
            .number()
            .int()
            .optional()
            .describe("페이지 범위 시작 (page_start 대신 사용). 인접 청크까지 함께 볼 때"),
          page_to: z.number().int().optional().describe("페이지 범위 끝"),
          chunk_index: z
            .number()
            .int()
            .optional()
            .describe("청크 인덱스로 직접 지정 (payload의 chunk_index)"),
          limit: z
            .number()
            .int()
            .min(1)
            .max(20)
            .default(5)
            .describe("반환할 청크 최대 개수 (기본 5)"),
        },
      },
      async ({ collection, doc_title, page_start, page_from, page_to, chunk_index, limit }) => {
        const cap = limit ?? 5;
        const all = await qdrantScroll(collection, null, 5000);

        if (all.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `'${collection}' 컬렉션에서 포인트를 찾지 못했습니다. ` +
                  `컬렉션 이름을 확인하거나 list_book_collections를 먼저 호출하세요.`,
              },
            ],
          };
        }

        // 문서 필터 (부분일치)
        let scoped = all;
        if (doc_title) {
          scoped = all.filter((p) => looseIncludes(payloadDocTitle(p.payload), doc_title));
          if (scoped.length === 0) {
            const docs = [...new Set(all.map((p) => payloadDocTitle(p.payload)))]
              .filter(Boolean)
              .sort();
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

        const byPage = (p) => {
          const s = p.payload?.page_start;
          return typeof s === "number" ? s : Number.MAX_SAFE_INTEGER;
        };
        const byIndex = (p) => {
          const i = p.payload?.chunk_index;
          return typeof i === "number" ? i : 0;
        };
        scoped.sort((a, b) => byPage(a) - byPage(b) || byIndex(a) - byIndex(b));

        // 위치 조건 적용
        let picked = null;
        if (chunk_index !== undefined && chunk_index !== null) {
          picked = scoped.filter((p) => p.payload?.chunk_index === chunk_index);
        } else if (page_start !== undefined && page_start !== null) {
          picked = scoped.filter((p) => p.payload?.page_start === page_start);
        } else if (
          (page_from !== undefined && page_from !== null) ||
          (page_to !== undefined && page_to !== null)
        ) {
          const lo = page_from ?? Number.MIN_SAFE_INTEGER;
          const hi = page_to ?? Number.MAX_SAFE_INTEGER;
          picked = scoped.filter((p) => {
            const s = p.payload?.page_start;
            return typeof s === "number" && s >= lo && s <= hi;
          });
        }

        // 위치 조건이 전혀 없으면 목차 성격의 안내를 돌려준다
        if (picked === null) {
          const lines = scoped
            .slice(0, 300)
            .map(
              (p) =>
                `  p.${p.payload?.page_start}~${p.payload?.page_end}` +
                ` (chunk_index ${p.payload?.chunk_index}, ${String(p.payload?.text || "").length}자` +
                `${p.payload?.content_type ? `, ${p.payload.content_type}` : ""})`
            );
          const title = doc_title || "(문서 전체)";
          return {
            content: [
              {
                type: "text",
                text:
                  `■ ${collection} / ${title} — 청크 ${scoped.length}개\n` +
                  `page_start·page_from~page_to·chunk_index 중 하나를 지정해 다시 호출하세요.\n\n` +
                  `${lines.join("\n")}${scoped.length > 300 ? "\n  ... (이하 생략)" : ""}`,
              },
            ],
          };
        }

        if (picked.length === 0) {
          const pages = [...new Set(scoped.map((p) => p.payload?.page_start))]
            .filter((v) => typeof v === "number")
            .sort((a, b) => a - b);
          return {
            content: [
              {
                type: "text",
                text:
                  `지정한 조건에 해당하는 청크를 찾지 못했습니다.\n\n` +
                  `이 문서에 존재하는 page_start 값: ${pages.join(", ")}\n\n` +
                  `page_start는 청크의 '시작' 페이지입니다. 중간 페이지(예: p.354)로는 찾을 수 없으니, ` +
                  `page_from~page_to 범위로 다시 시도하세요.`,
              },
            ],
          };
        }

        let budget = MAX_TOTAL_CHARS;
        const blocks = picked.slice(0, cap).map((p) => {
          const pl = p.payload || {};
          const full = String(pl.text || "");
          const room = Math.max(0, budget);
          const body = full.slice(0, room);
          budget -= body.length;
          const cut =
            full.length > body.length
              ? `\n(응답 총량 상한 ${MAX_TOTAL_CHARS}자에 걸려 ${body.length}/${full.length}자만 표시됨 — limit을 줄이거나 청크를 하나씩 조회하세요)`
              : "";
          const head =
            `■ ${payloadDocTitle(pl)} p.${pl.page_start}~${pl.page_end}` +
            ` (chunk_index ${pl.chunk_index}, 전체 ${full.length}자` +
            `${pl.content_type ? `, ${pl.content_type}` : ""})`;
          return `${head}\n\n${body}${cut}`;
        });

        const more =
          picked.length > cap
            ? `\n\n(조건에 맞는 청크 ${picked.length}개 중 ${cap}개만 표시 — limit을 늘리거나 조건을 좁히세요)`
            : "";

        return {
          content: [
            {
              type: "text",
              text: `청크 전문 조회 결과 ${Math.min(picked.length, cap)}건 (컬렉션: ${collection})\n\n${blocks.join(
                "\n\n────────\n\n"
              )}${more}`,
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
          "조문 단위로 저장된 컬렉션(ponylink_rules)에서만 동작하며, 책 컬렉션의 청크 전문은 get_chunk_text를 쓰세요.",
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
                  `책·해설서 컬렉션에서 청크 전문이 필요하면 get_chunk_text를, ` +
                  `키워드로 찾으려면 search_book_library를 사용하세요.`,
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

// ─── 접근 게이트 ─────────────────────────────────────────────────────────────
// 이 서버는 포니링크 사규(ponylink_rules)를 포함한 지식베이스를 다루므로, 엔드포인트
// 주소만 알면 누구나 호출할 수 있는 상태를 막는다. 호출자는 URL 쿼리스트링으로
// 발급받은 게이트키를 전달한다:  https://<도메인>/api/mcp?k=<발급키>
//
//   MCP_GATE_KEYS : 허용 키 목록(쉼표 구분). **비어 있으면 게이트가 아예 비활성**이라
//                   모든 요청이 통과한다(코드만 배포하고 키를 안 넣은 상태 = 종전과 동일).
//   MCP_GATE_MODE : "enforce" 이면 키가 없거나 목록에 없을 때 401로 차단.
//                   그 밖의 값(기본 "observe")이면 통과시키되 로그만 남긴다.
//                   → 커넥터 URL을 새 주소로 교체하는 기간에 서비스가 끊기지 않도록
//                     먼저 observe로 배포해 로그를 확인한 뒤 enforce로 올리는 용도.
//
// 로그에는 키 전문을 남기지 않고 발급 대상 식별자(plk_<대상>_... 의 <대상>)만 남긴다.
// 이 로그가 곧 사용량·이상징후 확인 수단이 된다(Vercel 함수 로그에서 조회).
const GATE_KEYS = (process.env.MCP_GATE_KEYS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const GATE_MODE = (process.env.MCP_GATE_MODE || "observe").trim().toLowerCase();

function keyLabel(k) {
  if (!k) return "(none)";
  const m = String(k).match(/^plk_([A-Za-z0-9]+)_/);
  return m ? m[1] : `${String(k).slice(0, 8)}…`;
}

function withGate(h) {
  return async (req, ctx) => {
    let k = null;
    try {
      k = new URL(req.url).searchParams.get("k");
    } catch (e) {
      k = null;
    }
    const allowed = GATE_KEYS.length === 0 || (!!k && GATE_KEYS.includes(k));
    console.log(
      `[gate] mode=${GATE_MODE} method=${req.method} caller=${keyLabel(k)} allowed=${allowed}`
    );
    if (!allowed && GATE_MODE === "enforce") {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32001,
            message:
              "접근 권한이 없습니다. 이 서버는 발급받은 게이트키가 포함된 주소(…/api/mcp?k=<발급키>)로만 호출할 수 있습니다.",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    return h(req, ctx);
  };
}

export const GET = withGate(handler);
export const POST = withGate(handler);
export const DELETE = withGate(handler);
