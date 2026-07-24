# PDF-vectorDB-MCP — 그림/도표 캡션화 도구

포니링크 IT사업본부 PDF 지식베이스(`mna_playbook`, `contract_playbook`, `valuation_playbook`)는
지금까지 책의 **본문 텍스트만** 청크 단위로 임베딩해왔습니다. 그 결과 박스+화살표로 된
거래구조도, 조직도, 흐름도 같은 **그림/도표는 검색이 되지 않는** 문제가 있었습니다
(OCR이 그림 속 텍스트를 파편화된 형태로만 인식하거나, 순서가 뒤바뀌어 추출되는 경우도 있음).

이 저장소는 그림이 있는 페이지를 찾아내고, 사람이 원본을 육안으로 확인해 작성한
캡션(그림 설명 텍스트)을 기존 텍스트 청크와 동일한 스키마로 Qdrant에 추가하는 도구를 담습니다.

## 작업 흐름

### 1단계 — 그림이 있는 페이지 후보 찾기

```bash
# 페이지별 임베디드 이미지 개수 확인 (스캔본 PDF 기준)
pdfimages -list book.pdf > imglist.txt

# 이미지 2개 이상인 페이지 = 그림/장식 아이콘 후보
awk 'NR>2{print $1}' imglist.txt | sort -n | uniq -c | awk '$1>=2{print $2}'
```

**주의:** 페이지 상단에 매 페이지 반복되는 로고/장식 아이콘도 이미지로 카운트되므로,
이미지 개수만으로 그림 여부를 단정하면 안 됩니다(실제로 표(table) 페이지를 그림으로
오판했던 사례가 있었습니다). 후보 페이지는 반드시 아래 순서로 재검증하세요:

1. `pdftotext -layout -f N -l N book.pdf -` 로 본문 전체(헤더 제외)를 읽어서
   표/문장이 정상적으로 열 정렬되어 있으면 → 그림이 아니라 표/텍스트이므로 제외
2. 본문이 파편화되어 있거나("거래구조", "거래 종료 후" 같은 표제만 있고 이어지는
   문장이 어색하게 끊기면) → 그림일 가능성이 높으므로 실제 페이지를 래스터화해서 확인

   ```bash
   pdftoppm -jpeg -r 130 -f N -l N book.pdf /tmp/page_N
   ```

3. 래스터화한 이미지를 Claude(Vision) 또는 사람이 직접 보고 캡션 작성

### 2단계 — 캡션 JSON 작성

`examples/figure_captions.example.json` 형식을 참고하여 페이지별로 작성합니다.

```json
[
  {"page": 71, "title": "삼각합병 거래구조도", "caption": "삼각합병 거래구조도. ..."}
]
```

**캡션 작성 시 유의사항 (실제로 겪은 오류들):**
- 도해 안의 **수치(지분율 %)를 빠짐없이** 포함할 것 — 검색 시 "76% 지분" 같은 구체적 질문에
  답하려면 캡션에 숫자가 있어야 함
- 화살표의 **방향과 주체를 정확히** 명시할 것 — "A→B"와 "B→A"를 혼동하면 절차/구조를
  거꾸로 이해하게 되는 심각한 오류로 이어짐 (예: 자산부채 승계 방향, 지분 취득 방향)
- 순서가 있는 흐름도는 **논리적 순서대로** 캡션을 작성할 것. OCR 텍스트 추출 순서가
  원본 그림의 시각적 순서와 다를 수 있으므로, 반드시 래스터화한 이미지를 직접 보고
  왼쪽→오른쪽/위→아래 순서를 확인한 뒤 캡션에 반영할 것
- 그림 안에 있던 사례명(예: "사례 3 고가 실권주 재배정")이 있다면 캡션 제목에 포함시켜
  검색어와 매칭될 확률을 높일 것

### 3단계 — Qdrant 업서트

```bash
export QDRANT_URL="https://<cluster-id>.<region>.aws.cloud.qdrant.io:443"   # 포트 443 필수
export QDRANT_KEY="..."
export VOYAGE_KEY="..."

python scripts/upsert_figure_captions.py \
    --collection mna_playbook \
    --book-title "기업금융과 M&A (2022)" \
    --year 2022 \
    --captions-file my_captions.json \
    --chunk-index-offset 1000
```

`--dry-run` 옵션을 주면 임베딩/업서트 없이 생성될 페이로드만 확인할 수 있습니다.

### 4단계 — 검증

기존 `search_book_library` MCP 도구(또는 Qdrant `query_points`)로 그림 관련 질문을 검색해
캡션이 상위에 노출되는지, 내용이 원본과 일치하는지 확인합니다.

## 환경변수 요약

| 변수 | 설명 |
|---|---|
| `QDRANT_URL` | Qdrant Cloud REST 엔드포인트. **포트는 443** 사용 (6333은 일부 네트워크에서 차단됨) |
| `QDRANT_KEY` | Qdrant Cloud API 키 |
| `VOYAGE_KEY` | Voyage AI API 키 (인덱싱 시 `input_type=document`) |

## 알려진 이슈 / TODO

- [ ] `mna_playbook` 외 `contract_playbook`, `valuation_playbook`에 속한 책들은 아직
      그림 스캔을 하지 않음
- [ ] 그림 자체(이미지 파일)는 저장하지 않고 캡션 텍스트만 저장 — 추후 원본 이미지 조회가
      필요하면 페이지 번호로 원본 PDF를 다시 열어야 함
