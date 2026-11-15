# WorldMonitor 3계층 단순화 설계

작성일: 2026-11-15 · 상태: 소유자 승인 (2026-11-15)

## 1. 의도

이 포크는 소유자 한 명이 쓰고 고치는 개인 프로젝트다. 원본은 수백만 명에게 서비스하기 위한 인프라(결제, 계정, 공용 캐시, 속도 제한, 배포 파이프라인, 데스크톱 앱, 외부 개발자용 SDK)를 열 달 동안 1만 커밋에 걸쳐 쌓았다. 그 결과 런타임 코드만 약 85만 줄이다.

이 서비스의 가치는 두 가지다.

1. **방대한 데이터 소스**: 누구도 총망라할 생각을 못 하는 수준의 외부 소스. 수집기 295개, 외부 호스트 884개.
2. **고유한 논리**: 그 데이터를 엮어 알려진 것 너머의 시각을 만드는 계산. 국가 위험도 점수(CII)와 이력, 교차 신호, 예측, 공급망 시나리오, AI 요약·브리핑.

목표는 이 두 자산을 그대로 둔 채, 둘을 감싼 구조를 걷어내 **소유자가 혼자 읽고 고칠 수 있는 크기**로 줄이는 것이다. 최종 구조는 세 계층이다.

- **프론트 서비스**: 화면(웹 대시보드, 터미널 대시보드, 블로그·문서 페이지)
- **백엔드 서비스**: 화면이 부르는 API와 고유 논리
- **외부 API 연결 계층**: 외부 소스에서 데이터를 받아 저장하는 수집기

## 2. 목표 · 비목표 · 반목표

**목표**
- 다중 사용자·상용 서비스용 코드와 설정을 모두 제거한다.
- 수집기와 고유 논리를 원본 그대로 유지한다.
- 최종적으로 코드를 세 계층 폴더로 재배치한다(2단계).
- 각 단계 끝에서 앱이 실행되고, 점수가 단계 전과 같게 나온다.

**비목표**
- 결제, 계정, 로그인, 구독 등급(무료/Pro)
- 여러 사용자를 위한 캐싱(공용 Redis 캐시 규칙, CDN 캐시, 세션 토큰, 속도 제한)
- 데스크톱 앱, 외부 개발자용 SDK·플러그인·MCP 엔드포인트
- 검색엔진·AI 검색 노출용 생성물(크롤 가능 코퍼스, sitemap, llms.txt, OG 이미지, SEO 수집기)
- 크로니클(별도 프로젝트) 연계. 한국 공공데이터를 WorldMonitor 수준으로 키우는 일은 이 작업 이후의 과제다.

**반목표** (기술적으로 돌아가도 실패로 보는 것)
- 데이터 소스의 폭이 줄어드는 것. 수집기를 "현재 화면이 안 쓴다"는 이유로 지우지 않는다.
- 위험도 점수·시나리오 결과가 원본과 달라지는 것. 입력 데이터와 공식은 원본 그대로다.
- 단순화한다면서 새 인프라(새 DB 서버, 새 메시지 큐, 새 프레임워크)를 들이는 것.

## 3. 제약

- 저장소: `origin` = `tkddls8848/worldmonitor`. PR 없이 `main`에 직접 커밋하고 푸시한다. `upstream`(koala73)에는 푸시하지 않는다.
- 런타임: Node.js 24(`.nvmrc`). 개인용 실행 경로가 기준이다.
  - `npm run build:personal`, `npm run start:personal`: 화면 + 로컬 API + 내장 저장소, 프로세스 하나
  - `WM_PERSONAL_STORE=embedded`: Redis 없이 `scripts/local/embedded-store.mjs`가 Upstash 호환 REST를 제공
  - `npm run collect:personal`: 수집기 실행
  - `npm run tui:personal`: 터미널 대시보드
- 수집기와 핸들러는 현재 저장소 키(`<key>` + `seed-meta:<key>`)로 연결되어 있다. 1단계에서는 이 연결을 바꾸지 않는다.
- 이미 실패 중인 테스트와 CI가 있다(Docker·Railway 삭제 이후). 1단계는 "새 실패를 만들지 않는다"를 기준으로 하고, 삭제 대상과 관련된 기존 실패는 해당 테스트와 함께 사라진다.

## 4. 접근 방식

| 방식 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A. 제자리에서 덜어내기 | 폴더 구조 유지, 쓰지 않는 것만 삭제 | 매 단계 동작 확인 가능, 위험 낮음 | 끝나도 구조가 세 계층으로 읽히지 않음 |
| B. 세 폴더로 새로 짜기 | `web/`·`backend/`·`connectors/`를 만들고 로직을 옮겨 담음 | 결과가 목표 구조와 정확히 일치 | 작업량 최대, 점수가 달라졌을 때 원인 추적 어려움 |
| **C. A 후 B (선택)** | 1단계로 덜어내고, 2단계로 줄어든 코드를 세 폴더로 재배치 | 각 단계 끝에 동작하는 상태가 남고, 2단계 대상이 작아짐 | 두 번에 걸친 작업 |

소유자가 C를 골랐다. 점수를 원본 그대로 유지하려면 "전과 같은 결과인지"를 계속 확인해야 하고, 먼저 덜어내면 비교 대상이 작아지기 때문이다.

이 문서는 **1단계를 실행 가능한 수준으로** 정하고, 2단계는 방향만 정한다. 2단계의 세부 설계는 1단계가 끝난 뒤 줄어든 코드를 보고 따로 쓴다.

## 5. 1단계: 제자리에서 덜어내기

### 5.1 남기는 것

- **수집기 전부**: `scripts/seed-*.mjs`, `scripts/seed-bundle-*.mjs`, `scripts/ais-relay.cjs`, 그 보조 모듈(`scripts/_*.mjs`, `scripts/lib/`, `scripts/shared/`, `scripts/regional-snapshot/` 등), `consumer-prices-core/`(국가별 소비자 물가 수집기, 데이터 소스의 일부)
- **고유 논리**: `server/worldmonitor/` 아래 도메인 핸들러(위험도 점수, 시나리오, 예측, 교차 신호, AI 요약 포함), `shared/`의 공용 규칙, `scripts/scenario-worker.mjs`, `scripts/run-local-scenario.mjs`
- **화면**: `src/`의 대시보드, 지도, 패널. `cli/src/tui/`(터미널 대시보드)
- **블로그·문서**: `blog-site/`, `docs/`의 내용(마크다운). 이를 어떤 방식으로 띄울지는 2단계에서 정한다.
- **개인용 실행 경로**: `scripts/personal-*.mjs`, `scripts/local/`, `shared/personal-store.mjs`
- **계약과 생성**: `proto/`, `src/generated/`, `Makefile`. 2단계에서 유지 여부를 정한다.
- **건강 상태 확인**: `api/health.js`. 수집이 얼마나 신선한지 보는 데 개인 사용자에게도 쓸모가 있다.

### 5.2 지우는 것

범주별로 적는다. 경로는 2026-11-15 기준 조사 결과이며, 계획 단계에서 참조를 따라가며 확정한다.

**(1) 독립 디렉터리**
- `convex/`: 결제·계정·사용자 상태·메일
- `src-tauri/`: 데스크톱 앱. 단, `src-tauri/sidecar/local-api-server.mjs`는 개인용 서버가 로컬 API로 쓰고 있으므로 지우기 전에 `scripts/local/` 등으로 옮긴다.
- `workers/`: Cloudflare CORS 워커
- `sdk/`, `claude-plugin/`, `.antigravity-plugin/`, `skills/`, `integrations/`, `demos/`, `pro-test/`
- 루트 파일: `gemini-extension.json`, `mcp.json`, `mcp_config.json`, `server.json`, `plugin.json`, `vercel.json`, `middleware.ts`, `nixpacks.toml`, `scripts/nixpacks.toml`, `scripts/railway-services.json`

**(2) 공개 서비스용 HTML 진입점**
- `desktop-sign-in.html`, `mcp-grant.html`, `plugin.html`, `embed.html`, `verify.html`, 그리고 이들의 `src/*-main.ts` 진입 파일

**(3) API 진입점 (`api/`)**
- 계정·결제: `create-checkout`, `customer-portal`, `pro-business-upgrade`, `product-catalog`, `referral`, `me`, `user`, `user-api-keys`, `user-embed-keys`, `user-prefs`, `invalidate-user-api-key-cache`, `desktop-auth`, `desktop-key`, `wm-session`(세션 토큰 발급, 단 개인용 화면이 의존하면 단순화해 남김)
- OAuth·에이전트·MCP: `oauth`, `oauth-authorization-server`, `oauth-protected-resource`, `agent-auth`, `a2a`, `mcp`, `mcp-proxy`, `docs-mcp`, `skills`, `http-message-signatures-directory`, `widget-agent`
- 알림·외부 채널: `notify`, `notification-channels`, `notification-suppressions`, `slack`, `discord`, `channel-oauth-bind`, `telegram-feed`는 데이터 소스이면 남김
- 공개 사이트 부가 기능: `og-story`, `story`, `md-twin`, `embed`, `download`, `cache-purge`, `analytics-health`, `seed-contract-probe`
- 위 진입점만 쓰는 `api/_*.js` 보조 모듈(`_api-key*`, `_desktop-auth`, `_desktop-key-meter`, `_mcp-grant-hmac`, `_oauth-token`, `_session`, `_user-api-key`, `_rate-limit*`, `_upstash-ratelimit`, `_usage-telemetry`, `_sentry-*`, `_convex-error`, `_product-catalog.generated`, `_www-authenticate`, `_idempotency` 등)

**(4) 서버 공용 모듈의 다중 사용자 장치 (`server/_shared/`)**
- `premium-check`, `pro-entitlement`, `entitlement-check`, `entitlement-coverage`, `embed-entitlement`, `embed-session`, `auth-session`, `user-api-key`, `api-key-rate-limit`, `account-rate-limit`, `rate-limit`, `direct-llm-quota`, `backtest-stock-quota`, `turnstile`, `channel-oauth-state`, `notify-fields`, `internal-auth`
- `server/gateway.ts`의 해당 단계: API 키 검증, 속도 제한, 유료 등급 검사, 세션 검사, 데스크톱 분기. 남는 게이트웨이는 "경로 찾기 → 핸들러 실행 → 응답" 수준이 된다.
- 유료 경로 목록(`src/shared/premium-paths.ts`)과 이를 참조하는 분기

**(5) 브라우저 코드 (`src/`)**
- 로그인·결제·구독 UI(Clerk, Convex 연동, 결제 화면, 유료 잠금 표시)
- PWA·서비스 워커, Sentry, Vercel·Umami 분석
- 데스크톱(Tauri) 브리지와 사이드카 연동(`src/services/runtime.ts`의 fetch 패치 중 데스크톱 분기, `src/services/tauri-bridge.ts`)
- 공개 서비스용 진입점(embed, plugin 등)

**(6) 공개 노출용 생성물**
- `scripts/build-crawlable-corpus.mjs`, `build-sitemap.mjs`, `build-llms-full.mjs`, `build-ai-search.mjs`, `crawlable-*`, `freeze-crawlable-live-pulse.mjs`, `seo-*`, `generate-public-product-facts.mjs`와 그 산출물(`public/llms*.txt`, `public/ai-search.md`, 크롤 코퍼스, sitemap)
- `scripts/source-attribution.mjs`와 `shared/source-attribution-manifest.json`은 데이터 소스 목록(어떤 호스트에서 무엇을 받는지)을 기록하므로 **남긴다**. 공개 페이지 생성 부분만 뗀다.

**(7) 알림·메일 발송**
- 다이제스트 메일, Slack·Discord·이메일 발송, 무료 사용자 알림 정리 같은 `scripts/` 작업. 데이터 소스가 아니라 사용자에게 보내는 쪽이다.

**(8) CI와 저장소 운영 장치**
- `.github/workflows/` 49개 중 남길 것: `typecheck.yml`, `test.yml`, `lint-code.yml`, `proto-check.yml`. 나머지(배포·릴리스·SDK 발행·SEO·MCP 점검·데스크톱·PR 운영·외부 기여자 관리)는 지운다.
- PR 운영용 스크립트: `agent:pr-snapshot`, stacked-merge 관련, 기여자 신뢰 검사
- `ARCHITECTURE.md`의 CI 표를 남은 워크플로에 맞춘다(`npm run docs:check`가 검사).

**(9) 테스트**
- 지운 코드를 대상으로 하는 테스트는 함께 지운다.
- 남은 코드의 테스트가 지운 모듈을 import하면, 그 테스트를 고친다. 동작이 같다는 근거를 잃지 않도록 테스트를 지우기보다 고치는 쪽을 우선한다.

### 5.3 삭제 순서

바깥에서 안으로 지운다. 각 단계 끝에 5.4의 확인을 하고 커밋한다.

1. 기준선 기록(5.4)
2. 독립 디렉터리와 루트 파일 (1), 공개 HTML 진입점 (2)
3. CI 워크플로와 PR 운영 장치 (8)
4. 공개 노출용 생성물 (6), 알림·메일 (7)
5. API 진입점 (3)
6. 서버 다중 사용자 장치와 게이트웨이 단순화 (4)
7. 브라우저 코드 (5)
8. 남은 참조·죽은 코드 정리, 문서(`AGENTS.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `SELF_HOSTING.md`) 갱신

### 5.4 확인 방법

**기준선** (삭제 시작 전 한 번)
- `npm run collect:personal`로 저장소를 채운 뒤, 내장 저장소 스냅샷(`.personal/store.ndjson`)을 고정본으로 복사한다.
- 고정본을 띄운 상태에서 다음 응답을 JSON으로 저장한다.
  - 위험도 점수 전체 목록과 몇 개 국가의 상세(`intelligence` 서비스의 위험도 RPC)
  - 공급망 시나리오 1건(`npm run scenario:local`로 같은 입력)
  - `/api/bootstrap` 빠른·느린 묶음
  - `/api/health?compact=1`의 요약
- 실패 중인 테스트 목록(관련 테스트 파일 실행 결과)

**각 단계 끝**
- `npm run build:personal`과 `npm run start:personal`이 성공한다.
- 같은 고정본 스냅샷으로 위 응답을 다시 받아 기준선과 비교한다. 위험도 점수와 시나리오 결과는 **완전히 같아야** 한다. bootstrap은 지운 기능의 키만 빠져야 한다.
- `npm run tui:personal`이 뜨고 뉴스 화면이 그려진다.
- `npm run typecheck`, `npm run lint:boundaries`, 관련 테스트가 기준선보다 나빠지지 않는다.

**1단계 완료 조건**
- 5.2의 모든 범주가 지워졌거나, 남긴 이유가 이 문서에 적혀 있다.
- 기준선 비교가 통과한다.
- 코드 줄 수를 기준선과 함께 기록한다(목표 수치는 두지 않는다. 데이터와 논리를 지키는 것이 우선이다).

## 6. 2단계: 세 계층으로 재배치 (방향만)

```
web/          프론트 서비스: 대시보드, 지도, 패널, 터미널 대시보드, 블로그·문서 보기
backend/      백엔드 서비스: HTTP 서버, 핸들러, 고유 논리, 저장소 접근
connectors/   외부 API 연결 계층: 수집기, 외부 소스별 연결 코드, 수집 일정
```

2단계에서 정할 것:
- proto·코드 생성을 유지할지, 평범한 JSON 경로로 바꿀지
- 수집기와 백엔드를 계속 저장소 키로 연결할지, 함수 호출이나 SQLite로 바꿀지
- 블로그(Astro)·문서(Mintlify 형식 마크다운)를 어떻게 띄울지
- 수집 일정을 백엔드 프로세스 안에서 돌릴지

2단계의 설계 문서는 1단계 결과를 보고 별도로 작성한다.

## 7. 빌더에게 맡기는 것

- 각 범주 안에서 파일 단위 삭제 목록 확정(참조 추적 포함)
- 커밋 단위 분할(5.3의 단계보다 잘게 나눠도 된다)
- 기준선 비교 스크립트의 형태(스크래치 스크립트로 충분하다)
- 남은 코드에서 지운 모듈을 import하는 곳의 정리 방식

## 8. 검토에서 나온 결정

검토자가 계획 전에 확인이 필요하다고 짚은 항목과 그 결정이다. "설계자 판단"은 소유자와 합의하지 않고 설계자가 정한 것으로, 소유자가 고칠 수 있다.

**8.1 유료 전용 기능은 개인용에서 모두 동작하게 한다** (대화에서 이미 정해진 것)
시나리오 실행, 회복력 점수, 국가·지역 브리핑, 지역 스냅샷, 채팅 분석, 시장 영향, 종목 분석·백테스트, 교역·공급망 비용 충격 경로는 고유 논리에 속한다. 지금은 `src/shared/premium-paths.ts`와 `server/gateway.ts`의 유료 등급 검사 때문에 개인용 실행에서 막혀 있다. 등급을 없애면 이 기능들이 열려야 한다.
- 5.3의 6~7단계는 삭제만이 아니라 "잠금 해제 후 Clerk·Convex 없이 동작 확인"을 포함한다.
- LLM이나 외부 API 키가 필요한 기능은 키가 없을 때 "키 미설정"을 표시하고 다른 기능에 영향을 주지 않는다.

**8.2 Convex는 지우고, 정보 이력은 SQLite로 옮긴다** (소유자 결정 + 설계자 판단, 2026-11-15)
- **저장소**: 소유자 결정으로 Convex를 두지 않는다. 결제·계정 데이터는 버린다.
- **정보 이력**: `scripts/_seed-history.mjs`가 Convex에 쓰고, `search-intel-history`·`get-intel-timeline`·`get-similar-events`가 읽는다. 이 쓰기와 읽기를 `shared/personal-store.mjs`의 SQLite 파일로 옮긴다. 쓰는 소스와 내용은 바꾸지 않는다.
  - 이력 테이블은 키·값 저장소인 `shared/personal-store.mjs`가 아니라 같은 `node:sqlite`를 쓰는 별도 모듈 `shared/intel-history-store.mjs`에 둔다(설계자 판단). 파일은 `WM_INTEL_HISTORY_DB`, 비우면 `.personal/intel-history.sqlite`다. 구현 코드는 `scripts/lib/intel-history-store.mjs`에 있고 `shared/` 모듈은 그것을 다시 내보낸다. 수집기는 `scripts/` 밖을 import하지 못하기 때문이다(`tests/scripts-railway-nixpacks-no-escape-import.test.mts`).
- **비슷한 사건 검색**: 저장된 벡터를 전부 읽어 코사인 유사도를 직접 계산한다. 개인용 규모에서는 이것으로 충분하고, 벡터 검색 확장이나 별도 서버를 들이지 않는다.
- **임베딩**: 원본 그대로 OpenRouter의 `openai/text-embedding-3-small`(512차원)을 쓴다(소유자 결정, 2026-11-15). 소유자가 OpenRouter 키를 만들었다. 비슷한 사건 검색과 매일 AI 브리프의 기사 중복 제거(`scripts/lib/brief-embedding.mjs`)가 같은 임베더를 쓰며, 모델·차원·기준값(0.60, 0.45)·캐시 버전·이력 행의 모델 표시(`openai/text-embedding-3-small@512`)를 바꾸지 않는다.
  - 검토한 대안: 로컬 MiniLM(`Xenova/all-MiniLM-L6-v2`)을 이 PC에서 뉴스 제목 쌍으로 측정했다. 같은 사건(0.38~0.75)과 다른 사건(최고 0.62, 일본·페루 지진)의 점수가 겹쳐 하나의 기준값으로 가를 수 없었고, 영어 기사와 같은 사건의 한국어·러시아어 기사는 0.04~0.07로 무관하게 나왔다. 영어 전용 모델이라 다국어 피드에 맞지 않아 택하지 않았다. Ollama의 다국어 모델은 별도 프로그램을 켜 둬야 하고 기준값을 다시 맞춰야 해서 택하지 않았다.
  - 키가 없거나 호출이 실패하면 원본 동작대로 중복 제거는 단어 겹침(Jaccard) 방식으로 넘어간다.
- **"수집기를 그대로 둔다"의 범위**: 외부 소스, 받아오는 내용, 변환 논리를 바꾸지 않는다는 뜻이다. 저장 위치나 지운 인프라와의 연결 같은 배관은 고칠 수 있다.
- **알림 큐**(`wm:events:queue`): 꺼내 발송하는 쪽이 지워지므로, 수집기의 큐 쓰기는 남겨 두되 소비자는 두지 않는다. 큐가 무한히 쌓이지 않도록 길이 상한이 있는지 확인한다. 개인 알림은 이후 과제다.

**8.3 "AI 요약·브리핑"에는 매일의 AI 브리프도 포함한다** (설계자 판단)
`scripts/seed-digest-notifications.mjs`에서 브리프를 조립하는 부분은 남기고, 메일 발송 부분은 지운다. 사용자별 키(`brief:{userId}:…`)는 소유자 한 명 기준으로 단순화한다. `api/brief/*`, `api/latest-brief.ts`는 로그인·등급·서명 URL 검사를 걷어 내고 남긴다.

**8.4 기준선 비교는 반복 가능하게 바꾼다** (설계자 판단)
5.4의 "스냅샷을 띄우고 응답 비교"는 그대로는 반복되지 않는다. 위험도 점수가 현재 시각에 의존하고, 결과 캐시(`risk:scores:sebuf:v14`)를 그대로 돌려주며, 이력을 저장소에 다시 쓰고, 스냅샷 키에 절대 만료 시각이 있다. 그래서 다음 조건으로 비교한다.
- 시계를 고정한다.
- 결과 캐시를 우회한다.
- 스냅샷의 만료를 무시한다.
- 기존 도구 `scripts/cii-capture-fixture.mts`, `scripts/cii-table-diff.mts`를 우선 활용한다.

이 조건에서 결과가 같으면 "완전히 같다"로 본다.

**8.5 변형 사이트와 페이지는 1단계에서 남긴다** (설계자 판단)
- `tech`·`finance`·`happy`·`commodity`·`energy` 변형은 각자 뉴스 피드를 갖고 있어, 지우면 데이터 폭이 줄 수 있다. 1단계에서는 그대로 두고, 2단계에서 피드를 하나로 합칠지 정한다.
- `market.html`, `country.html`, `settings.html`, `live-channels.html`은 대시보드 기능이라 남긴다. `index.html`이 공개 랜딩 페이지라면 지운다.
- `api/ask.ts`, `api/chat-analyst.ts`, `api/travel-risk-assessment.ts`는 고유 논리로 보고 남긴다.
- `leads`, `feedback`, `giving` 도메인은 빌더가 데이터 소스인지 확인해서, 데이터 소스면 남기고 영업·문의용이면 지운다.

**8.6 원본 저장소와 결별한다** (소유자 결정, 2026-11-15)
`upstream`(koala73)의 이후 변경은 받아오지 않는다. 따라서 공유 파일(`server/gateway.ts` 등)을 과감하게 고쳐 쓰고 지워도 된다. 원본에 새 수집기가 생겨도 자동으로 들어오지 않는다.

**8.7 사용할 수 있는 AI 키는 Anthropic과 OpenRouter다** (소유자 답변, 2026-11-15. OpenRouter 키는 임베딩용으로 추가)
- **AI 기능**: 지금 기본 AI 호출 순서는 Ollama → OpenRouter → 무료 OpenRouter → 일반 엔드포인트이고, Anthropic은 호출하는 쪽이 지정할 때만 쓰인다(`server/_shared/llm.ts`, `scripts/lib/llm-chain.cjs`). 매일 AI 브리프는 OpenRouter로 고정돼 있다(`scripts/lib/brief-llm.mjs`). 개인용에서는 기본 순서의 첫 자리를 Anthropic으로 바꾸고 브리프 고정도 Anthropic으로 옮긴다(설계자 판단).
- **모델**: 기본 모델은 비용을 고려해 요약·분류처럼 자주 부르는 작업에 작은 모델을 쓰고, 브리프처럼 하루 몇 번인 작업만 큰 모델을 쓴다. 모델 이름은 환경 변수로 바꿀 수 있게 둔다(설계자 판단).
- **데이터 키**: ACLED, EIA, FRED, Finnhub 등 데이터 키가 없으므로, 기준선은 키 없이 받을 수 있는 입력만 담는다. 위험도 점수 입력 중 무엇이 기준선에 들어갔는지 기록한다. 원본도 2026년 7월부터 ACLED 없이 GDELT로 대체해 계산하고 있다.

**8.8 위험도 점수 공식의 구조** (소유자 요청으로 정리, 2026-11-15)
`server/worldmonitor/intelligence/v1/get-risk-scores.ts`의 `computeCIIScores`, 공식 버전 v14, 대상 31개국.
1. 입력 약 17종을 나라별 신호로 모은다.
2. 네 요소를 0~100으로 계산한다: 소요(unrest), 분쟁(conflict), 안보(security), 정보(information).
3. 사건 점수 = 소요×0.25 + 분쟁×0.30 + 안보×0.20 + 정보×0.25
4. 혼합 = 나라별 기본 위험도×0.4 + 사건 점수×0.6 + 가산점 11종(기후, 산불, 여행경보, 이스라엘 경보, 난민, 국경 급증, 뉴스 긴급도, 지진, 제재, 선박 신호 교란, 공습 압력)
5. 하한선: UCDP 전쟁 70 / 소규모 분쟁 50, 여행경보 금지 60 / 재고 50, 공습 압력 40~70. 최종 = min(100, max(하한선, 반올림(혼합)))
6. 24시간 전 점수와 비교한 추세, 하루 단위 이력 저장

이 구조는 1단계에서 바꾸지 않는다.
