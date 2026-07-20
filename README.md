# ponylink-kb-mcp

포니링크 IT사업본부 지식베이스(M&A 실무서, 영문계약 실무서, 가치평가 서적 등)를
Qdrant Cloud + Voyage AI 기반으로 검색하는 MCP(Model Context Protocol) 서버입니다.

## 제공 도구

- `list_book_collections` : 현재 등록된 컬렉션(주제 폴더) 목록과 청크 개수 조회
- `search_book_library` : 자연어 질의로 의미 기반 검색 (1차 벡터검색 + rerank 2차 재정렬)

## 배포 순서

### 1) GitHub 저장소에 push

```bash
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/Sejin-Koo/ponylink-kb-mcp.git
git branch -M main
git push -u origin main
```

### 2) Vercel 프로젝트 생성

1. https://vercel.com 로그인 → **Add New → Project**
2. 방금 push한 GitHub 저장소(`ponylink-kb-mcp`) 선택 → Import
3. Framework Preset은 Next.js로 자동 인식됨 (별도 설정 불필요)

### 3) Vercel 환경변수 등록

Vercel 프로젝트 → **Settings → Environment Variables**에서 아래 3개를 등록
(Production / Preview / Development 모두 체크):

| Key | Value |
|---|---|
| `QDRANT_URL` | Qdrant Cloud 클러스터 엔드포인트 |
| `QDRANT_API_KEY` | Qdrant API 키 |
| `VOYAGE_API_KEY` | Voyage AI API 키 |

등록 후 **Deploy** (또는 재배포) 실행.

### 4) 배포 확인

배포 완료되면 아래 형태의 URL이 생성됩니다:

```
https://ponylink-kb-mcp.vercel.app/api/mcp
```

터미널에서 정상 응답 확인:

```bash
curl -X POST https://ponylink-kb-mcp.vercel.app/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

`list_book_collections`, `search_book_library` 두 도구가 응답에 포함되면 정상입니다.

### 5) claude.ai에 커넥터로 등록

Settings → Connectors → "+" → Add custom connector
- URL: `https://ponylink-kb-mcp.vercel.app/api/mcp`
- 인증 불필요 (서버가 자체적으로 Qdrant/Voyage 키를 환경변수로 보유)

## 새 책/컬렉션 추가 시

1. 로컬에서 `create_collection.py`로 새 컬렉션 생성 (필요시)
2. `embed_and_upload.py`로 PDF 업로드
3. 이 MCP 서버는 컬렉션을 하드코딩하지 않고 Qdrant에서 동적으로 조회하므로
   **재배포 없이 즉시 검색 가능**합니다.
