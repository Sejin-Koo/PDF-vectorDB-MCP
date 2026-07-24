#!/usr/bin/env python3
"""
upsert_figure_captions.py

PDF 책의 "그림/도표"에 대한 캡션(텍스트 설명)을 Voyage AI로 임베딩하여
Qdrant의 기존 지식베이스 컬렉션(mna_playbook, contract_playbook, valuation_playbook 등)에
추가로 업서트하는 스크립트.

배경:
  포니링크 PDF-vectorDB-MCP 파이프라인은 책의 "텍스트"만 청크 단위로 임베딩해왔기 때문에,
  박스+화살표로 된 거래구조도/조직도/흐름도 같은 그림은 검색이 되지 않는 문제가 있었다.
  이 스크립트는 그림이 있는 페이지를 사람이 육안으로 확인하고 작성한 캡션 텍스트를
  기존 텍스트 청크와 동일한 스키마로 추가하여, "그림 내용"도 검색 가능하게 만든다.

입력 캡션 JSON 형식 (예시):
  [
    {"page": 71, "title": "삼각합병 거래구조도", "caption": "삼각합병 거래구조도. ..."},
    {"page": 103, "title": "법인주주 특수관계인 범위 개요도", "caption": "..."}
  ]

필요 환경변수:
  QDRANT_URL   - 예: https://<cluster-id>.<region>.aws.cloud.qdrant.io:443
                 (주의: Claude bash_tool 등 일부 네트워크 환경은 포트 6333이 막혀있으므로
                  반드시 포트 443을 사용할 것 — mcp-server-dev 스킬 참고)
  QDRANT_KEY   - Qdrant Cloud API 키
  VOYAGE_KEY   - Voyage AI API 키

사용 예:
  export QDRANT_URL="https://xxxx.aws.cloud.qdrant.io:443"
  export QDRANT_KEY="..."
  export VOYAGE_KEY="..."
  python upsert_figure_captions.py \\
      --collection mna_playbook \\
      --book-title "기업금융과 M&A (2022)" \\
      --year 2022 \\
      --captions-file figure_captions.json \\
      --chunk-index-offset 1000

주의사항 (mcp-server-dev 스킬 참고):
  - Qdrant 최신 클라이언트는 search() 대신 query_points()를 쓰지만, 이 스크립트는
    REST API(HTTP)를 직접 호출하므로 해당 사항 없음. upsert는 PUT /points 엔드포인트 사용.
  - Voyage AI는 인덱싱 시 input_type="document"를 반드시 지정해야 함
    (검색 시에는 input_type="query"를 쓰는 search 스크립트와 다름에 유의).
  - 기존 텍스트 청크와 chunk_index가 겹치지 않도록 --chunk-index-offset을 충분히 크게 설정할 것
    (예: 기존 청크가 0~430이면 1000 이상 사용).
"""

import argparse
import json
import os
import sys
import urllib.request
import uuid


def embed_texts(texts, voyage_key, model="voyage-3.5", batch_size=64):
    """Voyage AI로 문서 임베딩 생성 (input_type=document, 배치 처리)"""
    all_embeddings = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        req = urllib.request.Request(
            "https://api.voyageai.com/v1/embeddings",
            data=json.dumps({
                "input": batch,
                "model": model,
                "input_type": "document",
            }).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {voyage_key}",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
        all_embeddings.extend([d["embedding"] for d in data["data"]])
    return all_embeddings


def upsert_points(qdrant_url, qdrant_key, collection, points):
    """Qdrant REST API로 포인트 업서트 (wait=true로 동기 확인)"""
    req = urllib.request.Request(
        f"{qdrant_url}/collections/{collection}/points?wait=true",
        data=json.dumps({"points": points}).encode("utf-8"),
        method="PUT",
        headers={
            "api-key": qdrant_key,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--collection", required=True, help="Qdrant 컬렉션명 (예: mna_playbook)")
    parser.add_argument("--book-title", required=True, help="기존 텍스트 청크와 동일하게 맞출 book_title 값")
    parser.add_argument("--year", type=int, required=True, help="출판연도")
    parser.add_argument("--captions-file", required=True, help="캡션 JSON 파일 경로")
    parser.add_argument("--chunk-index-offset", type=int, default=1000,
                         help="기존 텍스트 청크의 chunk_index와 겹치지 않도록 하는 오프셋 (기본 1000)")
    parser.add_argument("--namespace-key", default=None,
                         help="포인트 ID 생성용 UUID5 네임스페이스 시드 (기본: '<collection>-figure-caption')")
    parser.add_argument("--dry-run", action="store_true", help="임베딩/업서트 없이 페이로드만 출력")
    args = parser.parse_args()

    qdrant_url = os.environ.get("QDRANT_URL")
    qdrant_key = os.environ.get("QDRANT_KEY")
    voyage_key = os.environ.get("VOYAGE_KEY")

    if not args.dry_run and not (qdrant_url and qdrant_key and voyage_key):
        sys.exit("환경변수 QDRANT_URL / QDRANT_KEY / VOYAGE_KEY 가 모두 필요합니다.")

    with open(args.captions_file, encoding="utf-8") as f:
        items = json.load(f)

    for it in items:
        for required in ("page", "title", "caption"):
            if required not in it:
                sys.exit(f"캡션 항목에 '{required}' 필드가 없습니다: {it}")

    namespace_seed = args.namespace_key or f"{args.collection}-figure-caption"
    namespace = uuid.uuid5(uuid.NAMESPACE_URL, namespace_seed)

    if args.dry_run:
        for it in items:
            pid = str(uuid.uuid5(namespace, f"page-{it['page']}"))
            print(json.dumps({
                "id": pid,
                "payload": {
                    "book_title": args.book_title,
                    "year": args.year,
                    "chunk_index": args.chunk_index_offset + it["page"],
                    "page_start": it["page"],
                    "page_end": it["page"],
                    "content_type": "figure_caption",
                    "figure_title": it["title"],
                    "text": it["caption"],
                }
            }, ensure_ascii=False, indent=2))
        return

    texts = [it["caption"] for it in items]
    print(f"[1/2] Voyage AI 임베딩 생성 중... ({len(texts)}개)")
    embeddings = embed_texts(texts, voyage_key)
    print(f"  -> 완료. 차원: {len(embeddings[0])}")

    points = []
    for it, vec in zip(items, embeddings):
        pid = str(uuid.uuid5(namespace, f"page-{it['page']}"))
        points.append({
            "id": pid,
            "vector": vec,
            "payload": {
                "book_title": args.book_title,
                "year": args.year,
                "chunk_index": args.chunk_index_offset + it["page"],
                "page_start": it["page"],
                "page_end": it["page"],
                "content_type": "figure_caption",
                "figure_title": it["title"],
                "text": it["caption"],
            }
        })

    print(f"[2/2] Qdrant 컬렉션 '{args.collection}'에 {len(points)}개 포인트 업서트 중...")
    result = upsert_points(qdrant_url, qdrant_key, args.collection, points)
    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("status") == "ok":
        print(f"\n완료: {len(points)}개 그림 캡션이 '{args.collection}' 컬렉션에 추가되었습니다.")
        print("동일한 --namespace-key와 페이지 번호로 재실행하면 같은 ID로 덮어쓰기(upsert)되므로 재실행에 안전합니다.")


if __name__ == "__main__":
    main()
