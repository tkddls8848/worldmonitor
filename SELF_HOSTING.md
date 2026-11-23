# 개인용 WorldMonitor 실행

이 포크는 소유자 한 사람이 자기 컴퓨터에서 쓰는 개인용 대시보드입니다.
구성은 네 가지입니다.

| 구성 요소 | 명령 | 역할 |
|---|---|---|
| 개인 서버 | `npm run start:personal` | 대시보드 화면과 로컬 API를 비밀번호로 보호해 제공합니다 |
| 내장 저장소 | 개인 서버 안에서 실행 | 수집 데이터와 갱신 시각을 메모리에 두고 `.personal/store.ndjson`에 기록합니다 |
| 수집기 | `npm run collect:personal` | 외부 데이터 소스에서 데이터를 받아 내장 저장소에 씁니다 |
| 터미널 대시보드 | `npm run tui:personal` | 같은 서버를 터미널에서 봅니다 |

Docker, nginx, Redis, Vercel, Railway, 계정 서비스는 필요 없습니다.
외부 데이터 제공자에 대한 네트워크 요청과 각 제공자의 API 키만 필요합니다.

## 준비

1. Node.js 24(`.nvmrc`)를 설치하고 `npm ci`를 실행합니다.
2. `.env.example`을 참고해 `.env.local`을 만듭니다. 이 파일은 커밋하지 않습니다.

필수 설정:

```sh
WM_PERSONAL_PASSWORD=<16자 이상>
WM_PERSONAL_STORE=embedded
UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079
UPSTASH_REDIS_REST_TOKEN=<16자 이상의 임의 토큰>
OPENROUTER_API_KEY=<AI 요약, 브리프, 시나리오, 여행 위험 평가, 채팅 분석가, 이력 임베딩>
```

선택 설정:

- `ANTHROPIC_API_KEY`: 있으면 LLM 호출이 Anthropic을 먼저 시도하고, 없거나 실패하면 OpenRouter로 넘어갑니다.
- `EARTHDATA_TOKEN`: 산업 활동(NO₂) 수집에 사용합니다. [NASA Earthdata Login](https://urs.earthdata.nasa.gov)에서 가입하고 **Generate Token**을 선택합니다. **Applications > Authorized Apps**에서 **NASA GESDISC DATA ARCHIVE**를 승인합니다. 토큰이 없으면 NO₂ 수집을 건너뜁니다.
- 데이터 소스별 키(예: `FRED_API_KEY`, `ACLED_*`, `NASA_FIRMS_API_KEY`): 키가 없는 수집기는 실패로 표시되고 나머지는 계속 진행합니다. 해당 패널은 데이터가 없다고 표시합니다.
- `WM_PERSONAL_USERNAME`(기본 `owner`), `WM_PERSONAL_HOST`(기본 `127.0.0.1`), `WM_PERSONAL_PORT`(기본 `3000`).
- `WM_INTEL_HISTORY_DB`: 이력 SQLite 파일 위치. 기본값은 `.personal/intel-history.sqlite`입니다.

## 실행

```sh
npm run build:personal      # VITE 비밀 키 검사, API 핸들러 빌드, 화면 빌드
npm run start:personal      # 화면 + API + 내장 저장소 (http://127.0.0.1:3000/dashboard)
npm run collect:personal    # 수집기 1회 실행. 반복하려면: -- --watch 15
npm run tui:personal        # 터미널 대시보드. 종료는 q
```

- 브라우저는 HTTP Basic 인증으로 로그인합니다. 사용자 이름은 `owner`, 비밀번호는 `WM_PERSONAL_PASSWORD`입니다.
- `collect:personal`은 모든 묶음과 개별 수집기를 돌립니다. 아직 신선한 수집기는 건너뛰고, 마지막 성공 시각은 `.personal/collect-state.json`에 남깁니다.
- `collect:personal`에 수집기 이름을 넘기면 신선도와 관계없이 그것만 실행합니다(`-- earthquakes bundle-climate`).
- 서버를 다시 시작하면 내장 저장소가 만료되지 않은 키를 복원합니다.
- 외부에서 접속하려면 HTTPS 역방향 프록시를 앞에 두고 서버는 루프백에 묶어 둡니다.

## 저장소

- 내장 저장소는 수집기와 API가 실제로 쓰는 명령만 구현합니다. Lua는 실행하지 않고, 수집 잠금용으로 고정된 스크립트만 같은 동작으로 대신 처리합니다. 그 밖의 `EVAL`은 거부합니다.
- 이력 검색은 Node 내장 `node:sqlite` 파일을 씁니다. 임베딩은 `openai/text-embedding-3-small`(512차원)이며 OpenRouter 키가 없으면 수집기가 이력 쓰기를 건너뜁니다.
- 내장 저장소 대신 별도 프로세스를 쓰려면 `npm run start:local-store`로 루프백 REST 어댑터를 띄울 수 있습니다. 개인 서버는 루프백 주소의 `UPSTASH_REDIS_REST_URL`만 받습니다.

## 공급망 시나리오를 파일에서 계산

```sh
npm run scenario:local -- --snapshot seeds.json --scenario hormuz-tanker-blockade --country KR --severity 50 --output result.json
```

`seeds.json`은 `seed-meta:supply_chain:chokepoint-exposure`와
`supply-chain:exposure:{ISO2}:{HS2}:v1` 키를 디코딩된 JSON 값에 매핑한 객체입니다.
SQLite에 저장된 노출 데이터를 쓸 때는 `--database personal.sqlite`를 지정합니다.
결과는 상대 노출도이며 실제 손실 금액이나 사건 발생 확률이 아닙니다.
브라우저의 비동기 시나리오 기능과는 별개입니다.

## 공개 배포를 다시 고려할 때

이 구성은 계정, 결제, 분석, 오류 보고가 없는 개인용입니다.
다른 사람에게 공개하려면 개인정보 처리방침을 먼저 작성해야 합니다.
필요한 공개 항목은 [docs/internal/public-launch-disclosures.md](docs/internal/public-launch-disclosures.md)에 정리되어 있습니다.
