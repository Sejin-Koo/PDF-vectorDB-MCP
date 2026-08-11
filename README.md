# PDF-vectorDB-MCP (ponylink-kb-mcp)

포니링크 IT사업본부 지식베이스(사규·정관, M&A 실무서, 영문계약 실무서, 가치평가 서적,
KRX 공시·상장관리 해설 등)를 Qdrant Cloud + Voyage AI 기반으로 검색하는
MCP(Model Context Protocol) 서버입니다.

- GitHub 저장소: `Sejin-Koo/PDF-vectorDB-MCP`
- 배포 주소: `https://pdf-vector-db-mcp.vercel.app/api/mcp`

## 제공 도구

- `list_book_collections` : 현재 등록된 컬렉션(주제 폴더) 목록과 청크 개수 조회
- `search_book_library` : 자연어 질의로 의미 기반 검색 (1차 벡터검색 + rerank 2차 재정렬).
  사규 컬렉션이면 출처에 조문 번호·표제를 함께 표시하고, 발췌는 700자에서 절단
- `get_rule_article` : **조문 번호로 사규·정관 원문을 정확히 일치 조회**. `article_no`를
  생략하면 해당 문서의 조문 목차(조 번호 + 표제)를 반환. 번호 표기는 `제56조` `56`
  `8조의2` `제8조의 2` `56-2` `부칙` 모두 정규화되며, `context` 옵션으로 앞뒤 인접 조문을
  함께 조회. 조문 메타데이터가 있는 컬렉션(`ponylink_rules`)에서만 동작

> 조문 번호를 아는 조회에 `search_book_library`를 쓰지 마세요. 의미검색은 조 번호를
> 이해하지 못해, 그 조문이 색인에 없어도 비슷한 다른 조문을 반환합니다. 번호를 아는
> 조회는 `get_rule_article`로 해야 부존재를 정확히 판정할 수 있습니다.

## 배포 순서

### 1) GitHub 저장소에 push

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/Sejin-Koo/PDF-vectorDB-MCP.git
git branch -M main
git push -u origin main
```

### 2) Vercel 프로젝트 생성

1. https://vercel.com 로그인 → **Add New → Project**
2. 방금 push한 GitHub 저장소(`PDF-vectorDB-MCP`) 선택 → Import
3. Framework Preset은 Next.js로 자동 인식됨 (별도 설정 불필요)

### 3) Vercel 환경변수 등록

Vercel 프로젝트 → **Settings → Environment Variables**에서 아래 3개를 등록
(Production / Preview / Development 모두 체크):

| Key | Value |
|---|---|
| `QDRANT_URL` | Qdrant Cloud 클러스터 엔드포인트 (포트 443) |
| `QDRANT_API_KEY` | Qdrant API 키 |
| `VOYAGE_API_KEY` | Voyage AI API 키 |

값은 반드시 **Value 칸**에 넣으세요. 그 아래 Note 칸에 넣으면 키가 빈 값으로 배포되며,
UI상으로는 정상 등록된 것처럼 보입니다. 값 변경 후에는 **Redeploy**해야 반영됩니다.

### 4) 배포 확인

배포 주소는 다음과 같습니다:

```
https://pdf-vector-db-mcp.vercel.app/api/mcp
```

터미널에서 정상 응답 확인:

```bash
curl -X POST https://pdf-vector-db-mcp.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`list_book_collections`, `search_book_library`, `get_rule_article` 세 도구가 응답에
포함되면 정상입니다. 커밋 후 Vercel 배포가 전파되기까지 수 분 걸릴 수 있으므로,
도구 수가 예전 그대로면 잠시 뒤 다시 확인하세요.

### 5) claude.ai에 커넥터로 등록

Settings → Connectors → "+" → Add custom connector
- URL: `https://pdf-vector-db-mcp.vercel.app/api/mcp`
- 인증 불필요 (서버가 자체적으로 Qdrant/Voyage 키를 환경변수로 보유)

## 새 책/컬렉션 추가 시

1. 로컬에서 `create_collection.py`로 새 컬렉션 생성 (필요시)
2. `embed_and_upload.py`로 PDF 업로드
3. 이 MCP 서버는 컬렉션을 하드코딩하지 않고 Qdrant에서 동적으로 조회하므로
   **재배포 없이 즉시 검색 가능**합니다.

## 사규 컬렉션(ponylink_rules) 색인 규칙

`get_rule_article`이 동작하려면 청크 payload에 `article_no`, `article_title`, `chapter`,
`section`이 있어야 합니다. 사규를 색인할 때는 다음을 지키세요.

1. 조문 시작은 **"제N조" 뒤에 표제 괄호가 오는 경우로 한정** (`제N조(...)`, `제 N 조 (...)`,
   `제N조【...】`). "제462조에 따라", "제22조의 규정에 의한" 같은 **인용문을 조문 시작으로
   오인하면 본문이 통째로 사라집니다.**
2. "이 규정은 ~"으로 시작하는 문장을 부칙 시행일로 자동 판정하지 마세요. 본칙 제1조
   (목적·적용범위) 본문이 같은 말로 시작하는 경우가 많습니다.
3. 저장 후 **원본 문단 집합 ⊆ 저장 청크 집합**을 코드로 대조하고, 조문 결번·중복·표제
   누락 건수를 확인하세요.
