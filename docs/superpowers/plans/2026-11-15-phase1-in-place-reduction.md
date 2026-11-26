# 1단계 제자리 정리 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수집기와 고유 논리(위험도 점수, 시나리오, 요약·브리프)를 원본 그대로 둔 채, 다중 사용자·상용 서비스 코드를 저장소에서 걷어 내고 유료 기능을 모두 연다.

**Architecture:** 바깥(CI·생성물·독립 디렉터리)에서 안(API·게이트웨이·브라우저)으로 지운다. 지우기 전에 저장소가 끊기면 안 되는 두 가지를 먼저 옮긴다. 데스크톱 폴더 안의 로컬 API 서버는 `scripts/local/`로 옮기고, Convex에 쌓던 정보 이력은 `node:sqlite`로 옮긴다. 각 작업 끝에 기준선과 비교하는 "단계 확인"을 거쳐 커밋한다.

**Tech Stack:** Node.js 24, TypeScript, Vite, `node:sqlite`, `node:test`, 내장 저장소(Upstash 호환 REST)

**Spec:** `docs/superpowers/specs/2026-11-15-three-layer-simplification-design.md`

## Global Constraints

- `main`에 직접 커밋하고 `origin`(tkddls8848/worldmonitor)에 푸시한다. PR과 브랜치는 만들지 않고, `upstream`에는 푸시하지 않는다. 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`을 붙인다.
- Node.js 24(`.nvmrc`)를 쓴다. 이 PC는 현재 23.3이다. 작업 0 전에 24를 설치하고, 기준선과 이후 모든 확인을 같은 버전으로 실행한다.
- 수집기(`scripts/seed-*.mjs`, `scripts/seed-bundle-*.mjs`, `scripts/ais-relay.cjs`, `consumer-prices-core/`)는 외부 소스, 받아오는 내용, 변환 논리를 바꾸지 않는다. 저장 위치나 지운 인프라와의 연결 같은 배관만 고친다.
- 위험도 점수 공식 v14(`computeCIIScores`, `computeCiiScoreTable`)는 바꾸지 않는다. `cii-table-diff`에서 모든 나라의 Δ가 0이어야 한다.
- 임베딩은 `openai/text-embedding-3-small`, 512차원을 쓴다. 기준값 0.60/0.45, 캐시 버전 `v1:text-3-small-512`, 이력 행의 모델 표시 `openai/text-embedding-3-small@512`는 바꾸지 않는다.
- 새 인프라와 새 npm 의존성을 들이지 않는다. SQLite는 Node 내장 `node:sqlite`만 쓴다.
- `proto/`와 `src/generated/`는 바꾸지 않는다. 이 PC에는 `buf`도 `make`도 없다. 지운 도메인의 생성 파일은 쓰이지 않은 채로 두고, 2단계에서 정리한다.
- `api/*/v1/[rpc].js`는 빌드 산출물이다(gitignore). `.ts` 원본을 고친 뒤 `npm run build:personal`로 다시 만든다.
- `AGENTS.md`의 경계 규칙은 계속 지킨다. `api/*.js`는 `server/`나 `src/`를 import하지 않고, `server/`는 `src/components`나 `src/app`을 import하지 않으며, 브라우저 계층 순서를 따른다.
- 지운 코드를 대상으로 하는 테스트는 함께 지운다. 남은 코드의 테스트가 지운 모듈을 import하면, 지우기보다 고치는 쪽을 우선한다.
- 기준선보다 실패하는 테스트가 늘면 안 된다.
- 소유자 식별자는 `shared/personal-owner.js`의 `PERSONAL_OWNER_ID = 'owner'` 하나로 통일한다. 작업 5에서 만든다.

## Review Focus

1. **인증 정보 없이 부른 유료 RPC가 데이터를 돌려줘야 한다.** 개인 서버에서 세션도 키도 없이 부르면 401이 아니라 200이어야 한다. 테스트는 작업 7 `gateway-personal.test.mts`에 둔다.
2. **다른 임베딩 모델로 만든 이력 행은 검색에서 빠져야 한다.** 그 행을 버리고 `partial: true`를 표시해야 한다. 같은 모델의 결과를 밀어내면 안 된다. 테스트는 작업 2에 둔다.
3. **Anthropic 키가 없거나 호출이 실패하면 OpenRouter로 넘어가야 한다.** 요약과 브리프가 멈추면 안 된다. 테스트는 작업 3에 둔다.
4. **소비자가 없어진 `wm:events:queue`가 무한히 쌓이면 안 된다.** 쓰는 쪽이 길이를 1000으로 자른다. 테스트는 작업 5에 둔다.
5. **이력 DB 파일이 아직 없는 첫 실행, 두 수집기가 같은 DB에 동시에 쓰는 경우.** 파일이 만들어지고, 중복 행이 생기지 않아야 한다. 테스트는 작업 2에 둔다.

## 단계 확인 (각 작업의 마지막 단계에서 실행)

작업마다 다음을 순서대로 실행한다. `<N>`은 작업 번호, `<BASE_SHA>`는 작업 0이 `.personal/baseline/base/meta.json`에 적은 커밋이다.

1. `npm run build:personal`: 종료 코드 0.
2. `npm run start:personal`을 백그라운드로 띄운다. `curl http://127.0.0.1:3000/api/health?compact=1`이 200이어야 한다.
3. `node scripts/local/baseline/capture.mjs --label after-<N>`: 끝까지 실행된다.
4. `node scripts/local/baseline/compare.mjs <REF> after-<N>`: 마지막 줄이 `PASS`여야 한다. `<REF>`는 작업 0~7에서는 `base`, 작업 8부터는 작업 7이 만든 `base-unlocked`다. 세 가지를 확인한다.
   - 시나리오 결과가 같다.
   - bootstrap과 health는 키가 빠지기만 하고 새로 생기지 않는다. 빠진 키 목록이 출력된다.
   - 새로 실패한 테스트 파일이 없다.
5. `node --import tsx scripts/cii-table-diff.mts --base <BASE_SHA>`: 모든 행의 Δ가 0이다.
6. `npm run tui:personal`: 첫 화면에 뉴스 목록이 그려진다. 확인 후 종료한다.
7. 3의 결과(`typecheck`, `lint:boundaries` 오류 수)가 기준선 이하다. compare가 함께 검사한다.
8. 빠진 bootstrap·health 키가 그 작업에서 지운 기능의 키인지 확인하고, 커밋 메시지 본문에 적는다. 그다음 커밋하고 `git fetch origin && git push origin main`을 실행한다.

---

### Task 0: 기준선 도구와 기준선 기록

**Files:**

- Create: `scripts/local/baseline/capture.mjs`, `scripts/local/baseline/compare.mjs`, `scripts/local/baseline/run-tests.mjs`, `scripts/local/baseline/diff.mjs`
- Create: `tests/baseline-diff.test.mjs`
- Create: `tests/fixtures/scenario/baseline-snapshot.json`, `tests/fixtures/cii/<ISO 라벨>.json`(capture가 생성)
- Modify: `scripts/scenario-worker.mjs`. 기존 `const SCENARIO_TEMPLATES`에 `export`만 붙인다. 동작은 바꾸지 않는다.

**Interfaces:**

- Produces:
  - `diff.mjs`: `diffScenarioRuns(base: object[], after: object[]) → string[]`. 각 결과에서 `computedAt`을 뺀 뒤 깊은 비교하고, 차이마다 한 줄을 돌려준다.
  - `diff.mjs`: `diffKeySets(base: string[], after: string[]) → {removed: string[], added: string[]}`
  - `diff.mjs`: `diffTestRuns(base: Record<string,'pass'|'fail'>, after) → {newlyFailing: string[], removedFiles: string[]}`. 기준선에 없던 파일이 실패하면 `newlyFailing`에 넣는다.
  - `capture.mjs --label <L>`: 결과를 `.personal/baseline/<L>/`에 쓴다(`.personal/`는 이미 gitignore).
    - `meta.json`: `{commit, node, capturedAt}`
    - `bootstrap-keys.json`: fast·slow 묶음의 키 이름
    - `health-keys.json`: compact 요약의 항목 이름
    - `scenarios.json`
    - `tests.json`
    - `checks.json`: `{typecheckErrors, boundaryErrors}`
    - `loc.json`
  - `compare.mjs <baseLabel> <afterLabel>`: 차이를 출력하고 마지막 줄에 `PASS`나 `FAIL`을 쓴다. 통과 조건은 시나리오 차이 0줄, `added` 없음, `newlyFailing` 없음, 오류 수가 기준선 이하인 것이다. `removed` 키는 출력만 하고 실패로 보지 않는다.
  - `run-tests.mjs`: `tests/*.test.mjs`, `tests/*.test.mts`, `cli/test/*.test.mjs`를 파일 하나씩 따로 실행한다. `.mts`는 `node --import tsx --test`로 실행한다. 동시 실행 4개, 파일당 제한 시간 120초로 실행하고 `Record<file,'pass'|'fail'>`을 반환한다. Windows에서 `npm run test:related`가 테스트를 실행하지 못하기 때문에 따로 둔다.

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/baseline-diff.test.mjs`)
  - `diffScenarioRuns ignores computedAt`: `computedAt`만 다른 두 결과는 `[]`를 돌려준다.
  - `diffScenarioRuns reports a changed impact`: `records[0].impactPct` 40과 41을 비교하면 1줄이 나오고, 그 줄에 `impactPct`가 들어 있다.
  - `diffKeySets`: `['a','b']`와 `['a','c']`를 비교하면 `{removed:['b'], added:['c']}`이다.
  - `diffTestRuns`: `{x:'pass', y:'fail'}`와 `{x:'fail', y:'fail', z:'fail'}`를 비교하면 `newlyFailing`이 `['x','z']`, `removedFiles`가 `[]`이다.
- [ ] **Step 2:** `node --test tests/baseline-diff.test.mjs`를 실행한다. 모듈이 없어서 FAIL해야 한다.
- [ ] **Step 3:** `diff.mjs`를 구현한다.
- [ ] **Step 4:** 같은 명령으로 PASS를 확인한다.
- [ ] **Step 5: 시나리오 고정 입력을 만든다.**
  1. `npm run collect:personal -- hs2-chokepoint-exposure supply-vulnerability`를 실행한다.
  2. 성공하면 `.personal/store.ndjson`에서 `seed-meta:supply_chain:chokepoint-exposure`와 `supply-chain:exposure:*` 키를 꺼낸다. 문자열 값은 JSON으로 풀어 `tests/fixtures/scenario/baseline-snapshot.json`에 저장한다.
  3. 키가 없어 실패하면 `tests/local-scenario.test.mjs`의 스냅샷 모양을 따라 직접 만든다. KR, JP, DE 3개국 × HS2 `27`, `85`, `87`이고, 노출 대상은 `hormuz_strait`, `bab_el_mandeb`, `malacca_strait`로 한다. 어느 쪽을 택했는지 커밋 메시지에 적는다.
- [ ] **Step 6:** `capture.mjs`와 `run-tests.mjs`를 구현한다.
  - **시나리오**: `SCENARIO_TEMPLATES`의 모든 `id` × 나라(`null`, `'KR'`)를 `runLocalScenario(snapshot, id, country)`로 돌린다. 강도는 템플릿 기본값을 쓴다. 결과의 `coverage.status`가 `missing`이면 시간 예산 초과이므로 한 번 다시 돌린다.
  - **bootstrap·health**: `.env.local`의 Basic 인증으로 `/api/bootstrap?tier=fast`, `?tier=slow`, `/api/health?compact=1`을 읽어 키 이름만 저장한다.
  - **typecheck·boundary 오류 수**: `npm run typecheck`와 `npm run lint:boundaries` 출력에서 오류 줄 수를 센다.
  - **줄 수(loc)**: `git ls-files`에서 확장자가 `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.mts`인 파일의 줄 수를 더한다. `tests/`, `e2e/`, `docs/`, `src/generated/`, `*.generated.*`는 뺀다.
- [ ] **Step 7: 기준선을 기록한다.**
  1. `npm run collect:personal`로 저장소를 채운다.
  2. `npm run start:personal`을 띄운다.
  3. `WM_SEED_ENV_FILE=.env.local node --import tsx scripts/cii-capture-fixture.mts`를 실행해 `tests/fixtures/cii/`에 새 고정본을 만든다.
  4. 고정본에서 값이 비어 있지 않은 입력 키 목록을 커밋 메시지 본문에 적는다(설계 8.7의 "기준선에 들어간 입력" 기록).
  5. `node scripts/local/baseline/capture.mjs --label base`를 실행한다.
- [ ] **Step 8:** 단계 확인 4·5를 자기 자신과 비교해 돌린다(`compare.mjs base base`, `cii-table-diff --base HEAD`). `PASS`이고 모든 Δ가 0이어야 한다.
- [ ] **Step 9:** 커밋한 뒤 푸시한다. `meta.json`의 `commit`이 이후 모든 작업의 `<BASE_SHA>`다.
  - 커밋할 파일: 도구 4개, 테스트, 시나리오 고정본, CII 고정본, `scenario-worker.mjs`.
  - 커밋 메시지: `chore(personal): baseline capture and comparison tools`

### Task 1: 로컬 API 서버를 `scripts/local/`로 옮기기

**Files:**

- Move: `src-tauri/sidecar/local-api-server.mjs` → `scripts/local/local-api-server.mjs`
- Move: `src-tauri/sidecar/local-api-server.test.mjs` → `tests/local-api-server.test.mjs`. `../tauri.conf.json`과 `../../Dockerfile`을 읽는 단언은 지운다(:21, :34 근처).
- Move: `src-tauri/sidecar/youtube-embed-message.test.mjs` → `tests/youtube-embed-message.test.mjs`
- Modify (import 경로):
  - `scripts/personal-server.mjs:115`
  - `scripts/check-sidecar-shipped-routes.mjs:132`
  - 테스트: `tests/aircraft-input-boundary.test.mts:272`, `tests/aviation-news-boundary.test.mts:268`, `tests/desktop-ollama-reasoning-translation.test.mts:55`, `tests/desktop-ollama-translation.test.mts:45`, `tests/desktop-cloud-routed-features.test.mts:14`, `tests/google-dates-boundary.test.mts:82`, `tests/google-flights-boundary.test.mts:109`, `tests/mcp-registry-downstream.test.mjs:162`
  - 파일을 텍스트로 읽는 테스트: `tests/sidecar-cloud-preferred-seed-only.test.mjs:25`, `tests/sidecar-desktop-path-decisions.test.mjs:23`
- Modify: `package.json`의 `test:sidecar`에서 옮긴 두 테스트 경로를 뺀다. 남은 `src-tauri` 테스트는 작업 6에서 지운다.

**Interfaces:**

- Produces: `scripts/local/local-api-server.mjs`의 `createLocalApiServer(options)`. 시그니처는 그대로다.
  - 파일 안의 기준 폴더 계산(:16-17, `../..`)은 새 위치에서도 저장소 루트를 가리켜야 한다. `scripts/local/`도 루트에서 두 단계 아래이므로 값이 같다.
  - `scripts/`는 루트 `package.json`의 `"type"` 설정을 따른다. ESM이 아니면 확장자 `.mjs`가 ESM을 보장한다.

- [ ] **Step 1:** `git mv`로 세 파일을 옮기고 import 경로를 고친다.
- [ ] **Step 2:** 옮긴 테스트 2개와 경로를 고친 테스트 10개를 `run-tests.mjs`가 쓰는 방식으로 실행한다. 기준선에서 PASS였던 파일은 모두 PASS여야 한다.
- [ ] **Step 3:** 단계 확인을 한다. 시나리오, bootstrap, health는 기준선과 완전히 같아야 하고 빠진 키도 없어야 한다.
  - 커밋 메시지: `refactor(personal): move the local API server out of the desktop app`

### Task 2: 정보 이력을 SQLite로 옮기기

**Files:**

- Create: `shared/intel-history-store.mjs`, `tests/intel-history-store.test.mjs`
- Modify:
  - `scripts/_seed-history.mjs`: 쓰기 경로(:238-326, :874-1016)
  - `server/_shared/intel-history-client.ts`: 읽기 경로(:191-253)
  - `scripts/retract-intel-history.mjs`
  - `tests/seed-history.test.mjs`
  - `tests/intel-history-endpoints.test.mts`: :222와 :239의 상수 출처를 새 모듈로 바꾸고, Convex fetch 모의를 저장소 모의로 바꾼다.
  - `tests/retract-intel-history-cli.test.mjs`
- Delete:
  - `scripts/measure-intel-history.mjs`, `tests/measure-intel-history.test.mjs`
  - `scripts/run-cross-strait-history-one-off.mjs`와 `package.json`의 `railway:cross-strait-history:force`
- Modify: `.env.example`에 `WM_INTEL_HISTORY_DB`를 추가한다. 비워 두면 기본 경로를 쓴다는 설명을 붙인다.
- 설계 문서 8.2에 "이력 테이블은 키·값 저장소인 `shared/personal-store.mjs`가 아니라 같은 `node:sqlite`를 쓰는 별도 모듈 `shared/intel-history-store.mjs`에 둔다"를 추가한다(설계자 판단).

**Interfaces:**

- Produces (`shared/intel-history-store.mjs`):
  - 상수:
    - `INTEL_HISTORY_DIMS = 512`
    - `INTEL_HISTORY_EMBED_MODEL = 'openai/text-embedding-3-small@512'`
    - `INTEL_HISTORY_RETENTION_MS = 180 * 86_400_000`
  - `resolveIntelHistoryDbPath(env = process.env) → string`: `env.WM_INTEL_HISTORY_DB`가 있으면 그 값을 쓴다. 없으면 `<repo>/.personal/intel-history.sqlite`다.
  - `openIntelHistoryStore(filename, { now = Date.now, readOnly = false }) → store`
    - 폴더가 없으면 만든다.
    - WAL 모드, `busy_timeout=5000`
    - 테이블은 `intel_history`(벡터는 Float32 BLOB)와 `intel_history_retractions`다.
  - `store.append({domain, resource, runId, records}) → {inserted, skipped, retracted}`
    - 한 번에 100건까지 받는다. 넘으면 `TOO_MANY_RECORDS` 오류를 던진다.
    - 벡터가 유한수 512개가 아니면 그 호출 전체를 `INVALID_RECORD`로 거부한다.
    - 같은 배치 안과 이미 저장된 행 사이에서 `dedupeKey`로 중복을 거른다.
    - 취소 표시(tombstone)가 있는 키는 저장하지 않고 `retracted`로 센다. 이때 그 표시의 `retractedAt`을 지금 시각으로 갱신한다.
    - 저장하는 행에는 `embeddingModel = INTEL_HISTORY_EMBED_MODEL`과 `ingestedAt = now()`를 찍는다.
    - 같은 트랜잭션(`BEGIN IMMEDIATE`)에서 보존 기간이 지난 행과 취소 표시를 지운다. 행은 `ingestedAt` 기준, 취소 표시는 `retractedAt` 기준으로 180일이다. Convex의 매일 정리 작업을 대신한다.
  - `store.timeline({domain?, country?, from?, to?, limit?, cursor?}) → {records, partial, nextCursor}`
    - domain과 country가 모두 없으면 `ValidationError`를 던진다.
    - 정렬은 `occurredAt` 내림차순이고, 같으면 id 내림차순이다.
    - limit은 기본 50, 최대 200이다.
    - cursor는 불투명 문자열(`occurredAt:id`를 base64url로 인코딩)이다. 잘못된 cursor는 `ValidationError`를 던진다.
    - `partial`은 언제나 false다. 전부 훑기 때문이다.
  - `store.search({vector, domain?, country?, from?, to?, limit?, minScore?}) → {records, partial}`
    - SQL로 범위를 거른 행을 모두 읽어 코사인 유사도를 계산한다.
    - `embeddingModel`이 다른 행은 버리고 `partial = true`로 둔다. 모델 표시가 없는 옛 행은 현재 모델로 본다.
    - 그다음 `minScore`로 거르고, 점수 내림차순으로 정렬해 limit만큼 자른다. limit은 기본 20, 최대 64다.
    - 벡터 차원이 512가 아니거나 `minScore`가 [-1, 1] 밖이면 `ValidationError`를 던진다.
  - 각 레코드의 모양은 Convex `projectRecord`와 같다: `id, domain, resource, country, category, title, summary, sourceUrl, occurredAt, ingestedAt, runId, dedupeKey`. 벡터는 넣지 않는다. search 결과에는 `score`를 더한다.
  - `store.retract({dedupeKeys, reason}) → {retracted}`, `store.restore({dedupeKeys}) → {restored}`, `store.listRetractions({limit}) → {records}`. 각 호출은 키 100개까지 받는다.
  - `store.close()`
- Consumes: `server/_shared/intel-history-client.ts`의 공개 함수 시그니처와 `null` 반환 규약은 그대로 둔다. 실패하면 `null`을 돌려주고, 잘못된 cursor는 `ValidationError`를 던진다. 안에서 HTTP 대신 저장소를 연다(`readOnly: true`, 모듈 단위로 한 번만).
- Consumes: `_seed-history.mjs`는 Convex POST 대신 `store.append`를 50건 단위로 호출한다.
  - `{skipped:'unconfigured'}`가 되는 조건은 `OPENROUTER_API_KEY`가 없을 때뿐이다. `CONVEX_*`와 `RELAY_SHARED_SECRET`은 필요 없어진다.
  - 응답 검사(`inserted + skipped + retracted == chunk length`), 실행당 150건 상한, 필드 길이 상한, Redis 쪽 수집 상태 기록은 그대로 둔다.

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/intel-history-store.test.mjs`)
  - 각 테스트는 임시 폴더에 DB를 만들고, 시계를 `now`로 주입한다.
  - 원본 `convex/__tests__/intelHistory.test.ts`의 다음 구획을 옮긴다: append(106-271), timeline(288-516), search(563-708), prune(734-786), retract/restore(1160-2150 중 저장소 동작에 해당하는 부분).
  - 꼭 들어갈 이름과 단언:
    - `append stamps model and dedupes within and across runs`: 같은 `dedupeKey` 2건을 넣으면 `{inserted:1, skipped:1}`이다. 다시 넣으면 `{inserted:0, skipped:1}`이다.
    - `append rejects a 511-dim or non-finite vector`: 오류에 `INVALID_RECORD`가 들어 있고, 행은 0개다.
    - `append rejects 101 records`: 오류에 `TOO_MANY_RECORDS`가 들어 있다.
    - `two connections appending the same keys insert each once`: 같은 파일을 연 저장소 두 개가 같은 50건을 번갈아 넣으면 행은 50개다(Review Focus 5).
    - `first open creates the folder and file`: 없는 하위 폴더 경로로 열어도 성공하고, 파일이 생긴다(Review Focus 5).
    - `timeline orders newest first and pages with a cursor`: 행 5개를 limit 2로 읽으면 세 쪽에 걸쳐 5개가 나오고, 중복이 없고, 마지막 `nextCursor`는 `null`이다.
    - `timeline requires domain or country`: `ValidationError`를 던진다.
    - `timeline rejects a forged cursor`: `ValidationError`를 던진다.
    - `search ranks by cosine and applies minScore`: 쿼리와 같은 벡터의 점수는 1.0으로 1위다. `minScore: 0.99`면 그 행 하나만 남는다.
    - `search drops foreign-model rows and marks partial`: 다른 모델의 행 3개(점수 1.0)와 현재 모델의 행 2개를 limit 2로 검색하면, 현재 모델 2개가 나오고 `partial === true`다(Review Focus 2).
    - `append prunes rows older than 180 days`: 시계를 181일 넘긴 뒤 append하면 옛 행이 timeline에서 사라진다.
    - `retracted keys are not re-inserted`: retract 뒤 같은 키를 append하면 `{retracted:1}`이고, restore 뒤에는 `{inserted:1}`이다.
- [ ] **Step 2:** `node --test tests/intel-history-store.test.mjs`를 실행한다. 모듈이 없어서 FAIL해야 한다.
- [ ] **Step 3:** `shared/intel-history-store.mjs`를 구현한다.
- [ ] **Step 4:** 같은 명령으로 PASS를 확인한다.
- [ ] **Step 5:** `_seed-history.mjs`, `intel-history-client.ts`, `retract-intel-history.mjs`를 저장소로 바꾸고, 수정 대상 테스트 4개를 고친다. 고친 테스트는 모두 PASS여야 한다.
- [ ] **Step 6: 실제 경로를 확인한다.**
  1. `npm run collect:personal -- conflict-intel`을 실행한다.
  2. `.personal/intel-history.sqlite`에 행이 생겼는지 확인한다.
  3. 개인 서버에서 `get-intel-timeline`(domain `conflict`)과 `search-intel-history`(query `missile strike`)를 불러 `records`가 비어 있지 않은지 확인한다.
  - 이 단계에서 확인되는 것: OpenRouter 임베딩 → SQLite 쓰기 → 핸들러 읽기 경로 전체.
  - 확인되지 않는 것: 사이드카 번들 안에서 `node:sqlite`가 external로 남는지. build·start 성공으로 간접 확인한다.
- [ ] **Step 7:** 단계 확인을 한다. 이 작업에서 바뀌는 키는 없다.
  - 커밋 메시지: `feat(personal): store intel history in SQLite instead of Convex`

### Task 3: AI 호출 순서에서 Anthropic을 첫 자리로

**Files:**

- Modify:
  - `server/_shared/llm.ts`
    - :47-53 `PROVIDER_CHAIN`의 첫 원소를 `'anthropic'`으로 한다.
    - :58 `OPT_IN_PROVIDERS`는 빈 배열로 둔다.
    - `callLlmTool`(:396), `callLlmReasoning`(:408), `callLlmReasoningStream`(:432-434)의 기본 공급자를 `'openrouter'`에서 `'anthropic'`으로 바꾼다. 환경 변수로 덮어쓰는 규칙은 그대로다.
  - `server/_shared/llm-anthropic.ts:13`: 기본 모델을 `claude-haiku-5-5`로 한다. `ANTHROPIC_REASONING_MODEL`의 기본값은 `claude-sonnet-5-5`로 한다(:37-41).
  - `scripts/lib/llm-chain.cjs`: anthropic 항목(:67-74)의 `optIn`을 지운다. 기본 모델(:31)은 `claude-haiku-5-5`로 한다.
  - `scripts/lib/brief-llm.mjs`
    - :131 `BRIEF_LLM_ALLOWED_PROVIDERS = ['anthropic', 'openrouter']`
    - :141 모델 덮어쓰기에 anthropic 항목을 추가한다. 이야기별 호출 2종(:268, :428)은 `BRIEF_LLM_ANTHROPIC_SMALL_MODEL`(기본 `claude-haiku-5-5`), 다이제스트 문단(:1050)은 `BRIEF_LLM_ANTHROPIC_LARGE_MODEL`(기본 `claude-sonnet-5-5`)을 쓴다.
    - 제한 시간은 이야기별 10s에서 30s로, 다이제스트는 15s에서 60s로 늘린다.
    - 캐시 버전을 올린다: whymatters v7 → v8(:256), description v4 → v5(:411), digest v9 → v10(:1032).
  - `.env.example`에 `ANTHROPIC_MODEL`, `ANTHROPIC_REASONING_MODEL`, `BRIEF_LLM_ANTHROPIC_SMALL_MODEL`, `BRIEF_LLM_ANTHROPIC_LARGE_MODEL`을 추가하고, 작은 모델과 큰 모델의 용도를 한 줄씩 설명한다.
- Modify (테스트):
  - `tests/shared-llm.test.mts`: :222, :1102, :1110, :1119
  - `tests/ai-routing-policy.test.mts:152`
  - `tests/ai-routing-policy-railway.test.mjs`: :120, :126
  - `tests/brief-llm.test.mjs:344`
  - `tests/openapi-examples-contract.test.mjs:59-61`
  - `server/__tests__/summarize-article-routing-policy.test.ts:92`, `server/__tests__/summarize-article-llm-health.test.ts:126`. 이 둘은 `test:convex`(vitest)로 돈다. 작업 10에서 vitest를 지울 때 `tests/`로 옮길지 정한다. 여기서는 기대값만 고친다.
- 그대로 둘 것:
  - 임베딩: `brief-embedding.mjs`, `intel-history-embed.ts`
  - 자체 OpenRouter 체인을 쓰는 수집기: `seed-insights`, `seed-forecasts`, `regional-snapshot/*`, `ais-relay.cjs`. 설계 8.7의 범위는 기본 체인과 브리프다. 사용량 기록 모듈(`usage.ts`, `llm-telemetry.cjs`)은 `USAGE_TELEMETRY=1`일 때만 동작하므로 둔다.

**Interfaces:**

- Consumes/Produces: `callLlm`, `callLLM`, `generateWhyMatters`, `generateStoryDescription`, `generateDigestProse`의 시그니처는 그대로다.

- [ ] **Step 1: 테스트 기대값을 먼저 고친다.**
  - 기본 순서의 첫 원소가 `'anthropic'`이다.
  - `LLM_TOOL_PROVIDER`가 없으면 `'anthropic'`이 첫 자리다.
  - 브리프의 `allowedProviders`는 `['anthropic','openrouter']`다.
  - railway 테스트는 첫 호출 호스트로 `api.anthropic.com`을 기대한다.
  - 새 테스트 `falls back to openrouter when ANTHROPIC_API_KEY is unset`: 키가 없으면 첫 호출 호스트가 `openrouter.ai`다. `tests/ai-routing-policy-railway.test.mjs`에 둔다(Review Focus 3).
  - 새 테스트 `falls back to openrouter when anthropic returns 529`: 호스트 순서가 `['api.anthropic.com','openrouter.ai']`다. 같은 파일에 둔다.
- [ ] **Step 2:** 고친 테스트 파일들을 실행한다. 기대값이 바뀐 단언이 FAIL해야 한다.
- [ ] **Step 3:** 위 파일들을 수정한다.
- [ ] **Step 4:** 같은 테스트를 실행해 PASS를 확인한다.
- [ ] **Step 5: 실제 키로 확인한다.** 개인 서버에서 기사 요약 RPC(`/api/news/v1/summarize-article`)를 한 번 부르고, 서버 로그의 공급자가 `anthropic`인지 확인한다. `npm run collect:personal -- insights`도 성공해야 한다.
- [ ] **Step 6:** 단계 확인을 한다.
  - 커밋 메시지: `feat(personal): put Anthropic first in the LLM chain and the daily brief`

### Task 4: CI 워크플로와 PR 운영 장치 정리 (설계 5.2-(8))

**Files:**

- Delete `.github/workflows/`의 45개(남길 4개 외 전부):
  - analytics-collector-monitor, build-desktop, china-decision-parity-live, ci-health-scan, codeql, contributor-trust, crawlable-pulse-refresh, crawlable-pulse-rehearsal, desktop-release-train, e2e-visual
  - feed-validation, github-stars-refresh, indexnow-submit, issue-ui-evidence, live-api-cache-auth, live-video-source-audit, mcp-live-smoke, mcp-preset-liveness, mcp-tool-canary, mirror-claude-plugin
  - oil-calendar-horizon, open-data-chokepoints, openrouter-free-models-live, orphaned-stacked-merge-monitor, perf-style-layout-budget, pro-bundle-freshness, publish-cli, publish-e2e-screenshots, publish-go, publish-mcp-registry
  - publish-python, publish-ruby, publish-rust, pulse-freshness-monitor, resilience-snapshot-refresh, resilience-snapshot-rehearsal, review-pr-token-check, rust-sdk, security-audit, sentry-resolve-pin-audit
  - seo-gsc-weekly, stacked-merge-guard, status-page-monitor, test-linux-app, tps-open-data-live
- Modify:
  - `test.yml`
    - 지울 job: `zapier`(:270), `sidecar`(:742), `desktop-config`(:800), `desktop-node-windows`(:869), `desktop-rust`(:883), `convex-tests`(:918), `variant-smoke-pro-webmcp`(:1129)
    - 지울 단계: `pro-test` 설치·빌드(:525-548, :641, :1158-1161), `src-tauri` awk 필터(:170-265 안), `unit-built-output`의 데스크톱 환경 단계(:669-701 안)
    - `docs-stats` job은 남긴다.
  - `typecheck.yml`: :41의 `src-tauri` grep, :71, :75, :83-86을 지운다.
  - `lint-code.yml`: :112 `version:check`, :140 `lint:public-docs`, :150 mintlify slug, :163-201 Mintlify 내보내기를 지운다.
  - `proto-check.yml`: 바꾸지 않는다.
- Delete (PR 도구)와 해당 `package.json` 스크립트:
  - `scripts/agent-pr-snapshot.mjs`, `scripts/publish-pr-media-evidence.mjs`, `scripts/check-stacked-merge.mjs`, `scripts/merge-train.mjs`, `scripts/check-postmerge-deploys.mjs`, `scripts/check-review-pr-token.mjs`
  - 테스트: `agent-pr-snapshot`, `publish-pr-media-evidence`, `check-stacked-merge`, `merge-train`, `check-postmerge-deploys`, `stacked-merge-guard-workflow`
  - 스크립트: `agent:pr-snapshot`, `agent:attach-pr-evidence`
- Modify: `scripts/agent-preflight.mjs`의 `actionReadiness`(:694-756)에서 `pr_head_mismatch`, `pr_closed`, `pr_alignment_failed`, `duplicate_check_failed` 블로커를 지우고, `duplicatePrState`(:508)와 `prAlignment`(:553)도 지운다. `tests/agent-preflight.test.mjs`도 맞춰 고친다.
- Modify (훅):
  - `.husky/pre-commit`: `gh pr view` 검사를 지운다.
  - `.husky/pre-push`: 다음 검사를 지운다.
    - `gh` PR 상태 검사(:77부터)
    - branch-contamination guard(`prepush-attest.sh` 호출)
    - Convex typecheck(:608), sentry-convex(:618)
    - pro-test 빌드(:1008), `version:check`(:1124)
- Modify: `ARCHITECTURE.md` §11 CI 표(:401 이후)에서 지운 워크플로의 행을 지운다.

- [ ] **Step 1:** 파일을 지우고 위 수정을 한다.
- [ ] **Step 2:** `npm run docs:check`를 실행한다. PASS해야 한다(워크플로 표와 파일 목록 일치 검사).
- [ ] **Step 3:** 남긴 워크플로 4개를 `node -e`로 파싱한다. 루트 `node_modules`의 `yaml` 패키지를 쓰고, 없으면 `js-yaml`을 쓴다. 오류가 없어야 한다.
- [ ] **Step 4:** 단계 확인을 한다.
  - 커밋 메시지: `chore(personal): drop deployment, release and PR-operations automation`

### Task 5: 공개 노출용 생성물과 알림·메일 (설계 5.2-(6)(7), 8.3)

**Files — 생성물:**

- Delete:
  - 스크립트: `scripts/build-crawlable-corpus.mjs`, `scripts/build-sitemap.mjs`, `scripts/build-llms-full.mjs`, `scripts/build-ai-search.mjs`, `scripts/freeze-crawlable-live-pulse.mjs`, `scripts/generate-public-product-facts.mjs`, `scripts/generate-product-config.mjs`, `scripts/build-agent-skills-index.mjs`, `scripts/seo-*.mjs`
  - 스크립트: `scripts/crawlable-*.mjs` 중 `crawlable-live-tools.mjs`와 `crawlable-developments.mjs`를 뺀 나머지. 이 두 파일은 남은 서버 논리 `_country-brief-evidence.ts`의 동등성 테스트 기준이라 남긴다.
  - 산출물: `public/sitemap*.xml`, `public/llms*.txt`, `public/ai-search.md`, `public/crawlable-corpus.json`, 코퍼스 페이지 트리(/countries, /chokepoints, /crises, /sources)
  - 산출 JSON: `shared/product-facts.generated.json`, `shared/product-catalog.generated.json`과 `scripts/shared/`의 같은 두 파일. 단, 남은 코드가 import하면 남기고 그 사실을 커밋 메시지에 적는다.
  - 위를 대상으로 하는 테스트: crawlable-*(7), sitemap-generation, sitemap-verifier, seo-*(12), freeze-crawlable-live-pulse, llms-txt-mcp-tools, ai-search-product-facts, public-product-facts*, product-catalog-freshness, internal-link-redirects, country-corpus-slugs-freshness, pulse-freshness-monitor
  - 위를 부르는 `package.json` 스크립트: `build:crawlable-corpus`, `corpus:country-slugs*`, `audit:microstate-corpus`, `build:llms-full*`, `build:ai-search*`, `build:sitemap*`, `verify:sitemaps`, `seo:internal-links`, `freeze:crawlable-live-pulse`, `product:facts*`, `syndication:candidates`, `open-data:chokepoints`, `freeze:github-stars`, `build:agent-skills`
- Create: `scripts/lib/slugify.mjs`. `slugify`를 `build-crawlable-corpus.mjs`에서 그대로 옮긴다. `tests/country-brief-evidence.test.mts:26-28`의 import를 이 파일로 바꾼다.
- Modify: `scripts/generate-derived.mjs`의 `STEPS`(:36-63)에서 다음을 지운다: product facts, country corpus slugs, llms.txt, AI search, MCP source providers, Sentry Convex probe filters, desktop version. `source-attribution --write` 단계는 남긴다. `tests/generate-derived.test.mjs`도 맞춰 고친다.
- Modify: `package.json`의 빌드 스크립트
  - `prebuild`는 `npm run docs:dates -- --fetch-history && npm run build:openapi`로 줄인다.
  - `build`는 `npm run security:vite-env-secrets -- --strict-local && tsc && vite build`로 줄인다.
  - `build:full`과 `prebuild:*`(blog, full, tech, finance, happy, commodity, energy)에서 `product:facts`, 코퍼스, sitemap, `build:pro`, `build:agent-skills` 호출을 뺀다. 변형 빌드 자체는 남긴다(설계 8.5).
- Modify: `scripts/vercel-ignore.sh`를 지운다. Vercel이 없다.

**Files — 알림·메일:**

- Create: `shared/personal-owner.js`. `export const PERSONAL_OWNER_ID = 'owner';` 한 줄이다. 형식은 `shared/selfhost-relay-paths.js`와 같은 ESM이다.
- Modify: `scripts/seed-digest-notifications.mjs`
  - **남길 것**: `fetchLatestBriefEnvelope`(:396), `buildDigest`(:719-1077), `getLastSentAt`(:516), `isDue`(:565), `composeBriefsForRun`(:1570-1680), `composeAndStoreBriefForUser`(:1683-~2118), `main`의 브리프 조립 호출(:2294)과 기본 브리프 패스(:2995-3020)
  - **지울 것**: `formatDigest`(:1080), `deactivateChannel`(:1145), Telegram·Slack·Discord·Teams·이메일·webhook 발송(:1167-1458), `buildChannelBodies`(:1499-1550), 규칙별 발송 반복(:2341-~2990), 발송용 import(:39-58)와 비밀값(:164-198)
  - **사용자 목록**: Convex 사용자·규칙 조회(`fetchBriefOnlyUserIds` :2140, `fetchBriefComposeTimes` :2128과 그 호출)를 `PERSONAL_OWNER_ID` 하나로 바꾼다. 규칙 값은 기본 브리프 패스(:2995-3020)가 쓰는 기본값을 쓴다.
  - **결과 키**: `brief:owner:{slot}`, `brief:latest:owner`
  - 감시 목록 이야기 큐 쓰기(`scanAndEnqueueWatchlistStoryEvents` :638, :2170)는 남긴다.
- Modify: `scripts/personal-collect.mjs`의 `DEFAULT_COLLECTORS`에 `'digest-notifications'`를 추가한다. 실행 시점은 기존 `isDue`가 판단한다. `tests/embedded-store.test.mjs`의 존재 검사가 이를 확인한다.
- Delete:
  - 스크립트: `scripts/notification-relay.cjs`, `scripts/disable-free-user-notifications.mjs`, `scripts/import-bounced-emails.mjs`, `scripts/prune-digest-accumulator.mjs`, `scripts/replay-digest-cooldown.mjs`, `scripts/telegram/`, `scripts/check-alert-rule-shapes.mjs`
  - `scripts/lib`: `resend-send.cjs`, `resend-from.cjs`, `notification-teams.cjs`, `notification-webhook-ssrf.cjs`, `notification-webhook-signing.cjs`, `digest-email-html.mjs`, `email-summary-html.mjs`, `email-unsubscribe.cjs`, `digest-delivery-plan.mjs`, `digest-cooldown-*`, `user-context.cjs`, `followed-countries-fetch.cjs`
  - 각 파일의 테스트
- Modify (큐 길이 상한): 남은 `wm:events:queue` 생산자 4곳에서 `LPUSH` 바로 뒤에 같은 파이프라인으로 `LTRIM wm:events:queue 0 999`를 보낸다.
  - `scripts/ais-relay.cjs:975`
  - `scripts/seed-aviation.mjs:441`
  - `scripts/regional-snapshot/alert-emitter.mjs:404`
  - `scripts/lib/watchlist-story-scan.mjs:43`
  - `api/` 쪽 생산자는 작업 8에서 지운다.

- [ ] **Step 1:** 실패하는 테스트를 작성한다.
  - `tests/watchlist-story-scan.test.mjs`(없으면 만든다)에 `trims the event queue after each push`를 추가한다. 모의 파이프라인이 받은 명령 중 `LPUSH` 바로 다음 명령이 `['LTRIM','wm:events:queue','0','999']`여야 한다(Review Focus 4).
  - `tests/seed-digest-notifications*.test.mjs`(기존 파일명을 따른다)에 `composes the owner brief without any send channel`을 추가한다. 고정 이야기 3개와 모의 LLM으로 `composeAndStoreBriefForUser`를 부르면 `brief:latest:owner`에 쓰고, `fetch` 모의에 Resend·Telegram·Slack 호스트 호출이 0건이어야 한다.
- [ ] **Step 2:** 두 테스트를 실행한다. FAIL해야 한다.
- [ ] **Step 3:** 생성물과 알림의 삭제·수정을 한다.
- [ ] **Step 4:** 두 테스트와 `tests/source-attribution.test.mjs`, `tests/country-brief-evidence.test.mts`, `tests/brief-relevance.test.mjs`를 실행한다. 모두 PASS해야 한다.
- [ ] **Step 5:** `npm run generate:check`와 `npm run docs:check`를 실행한다. PASS해야 한다. 실패하면 `docs-stats.mjs`의 인벤토리 항목 중 지운 생성물을 가리키는 것을 지운다.
- [ ] **Step 6:** 단계 확인을 한다.
  - 커밋 메시지: `chore(personal): remove SEO generators and notification delivery, keep brief assembly`

### Task 6: 독립 디렉터리, 루트 파일, 공개·데스크톱 HTML 진입점 (설계 5.2-(1)(2))

`convex/`는 브라우저·API 코드가 아직 import하므로 작업 10에서 지운다.

**Files:**

- Delete (디렉터리): `src-tauri/`, `workers/`, `sdk/`, `claude-plugin/`, `.antigravity-plugin/`, `skills/`, `integrations/`, `demos/`, `pro-test/`
- Delete (루트 파일): `gemini-extension.json`, `mcp.json`, `mcp_config.json`, `server.json`, `plugin.json`, `vercel.json`, `middleware.ts`, `nixpacks.toml`, `scripts/nixpacks.toml`, `scripts/railway-services.json`, `vite.plugin.config.ts`
- Delete (HTML과 진입 파일)
  - `desktop-sign-in.html`, `mcp-grant.html`, `plugin.html`, `embed.html`, `verify.html`
  - `country.html`, `market.html`: 플러그인용 페이지다(`plugin-country-main.ts`, `plugin-market-main.ts`).
  - `settings.html`, `live-channels.html`: 데스크톱 창이다(`tauri-bridge` 사용). 웹 대시보드는 같은 기능을 `main.ts:670-684`의 `?settings=1`, `?live-channels=1`로 열고, 이 경로는 `settings-window.ts`, `live-channels-window.ts`를 쓰므로 남는다.
  - 진입 파일: `src/desktop-sign-in-main.ts`, `src/mcp-grant-main.ts`, `src/plugin-main.ts`, `src/plugin-country-main.ts`, `src/plugin-market-main.ts`, `src/plugin-*.ts` 보조 파일, `src/embed-main.ts`, `src/embed/`, `src/verify-main.ts`, `src/settings-main.ts`, `src/live-channels-main.ts`
  - 전용 스타일: `src/styles/plugin-*.css`, `src/styles/settings-window.css`. 단, `settings-window.css`를 `main.ts` 경로가 쓰면 남긴다.
- Delete (데스크톱 보조 스크립트): `scripts/download-node.sh`, `scripts/sync-desktop-version.mjs`, `scripts/check-rust-security-floors.mjs`, `scripts/check-build-prereqs.mjs`, `scripts/check-sidecar-shipped-routes.mjs`, `scripts/cloudflare-cache-rule.mjs`, `scripts/prepare-mcp-registry-manifest.mjs`, `scripts/publish-mcp-registry.mjs`, `scripts/extract-curated-command-surfaces.mjs`
- Modify:
  - `vite.config.ts`
    - :259 `PAGES_WITH_OWN_HEAD_META`에서 지운 페이지를 뺀다.
    - :1008의 `/embed.html` 헤더를 지운다.
    - :1349-1357 입력 목록은 `index.html`만 남긴다.
    - :1561의 `src-tauri/target` 감시 제외를 지운다.
  - `tsconfig.api.json:7`에서 `middleware.ts`를 뺀다. `biome.json:25`의 `pro-test` 재정의를 지운다.
  - `package.json`
    - 지울 스크립트: `tauri`, `desktop:*`, `build:desktop`, `prebuild:desktop`, `build:sidecar-sebuf`(단, `build:personal`이 쓰는 `scripts/build-sidecar-sebuf.mjs` 파일은 남긴다), `test:sidecar`, `version:sync`, `version:check`, `check:prereqs*`, `build:pro`, `build:plugin`, `test:e2e:mcp-grant`, `test:e2e:webmcp*`, `test:e2e:plugin-*`, `ci-smoke` 목록 안의 mcp·plugin spec
    - `lint`, `lint:fix`에서 `./middleware.ts`를, `lint:md`에서 `!skills/**`를 뺀다. `test:data`에서 `workers/...` glob을 뺀다.
    - `"@vercel/cli-config"` 블록(:360)을 지운다.
    - devDependency `@tauri-apps/cli`를 지운다.
  - 남은 스크립트의 참조: `scripts/docs-stats.mjs`(server.json), `scripts/lib/mcp-domain-summary.mjs`(server.json; 이 파일을 쓰는 곳이 MCP뿐이면 함께 지운다), `scripts/shared/data-test-durations.json:2222-2224`, `scripts/enforce-safe-local-storage.mjs`(mcp-grant)
  - `src/`의 지운 페이지 참조: `src/services/desktop-sign-in-page.ts`, `src/utils/desktop-sign-in-waiting.ts`, `src/services/mcp-grant-denial.ts`, `src/config/agent-not-found.ts`, `api/api-route-exceptions.json`. 앞의 세 파일은 지운 페이지 전용이면 지운다.
- Delete (테스트): 지운 파일을 읽거나 import하는 테스트
  - 예: deploy-config, middleware-*, csp-*, edge-functions, claude-plugin-package, agent-plugins-manifest, sdk-packages, cli-curated-commands-parity, agent-mode-view, mcp-published-endpoint-canonical, `*-registration`, nixpacks-*, railway-*, scripts-railway-nixpacks-no-escape-import, cors-fail-closed, package-test-command-paths, dependency-security-regression(zapier 부분만 지운다), embed-entry-boundary, `tests/dom/verify-page`, verify-page-built-head, desktop-*, download-node, rust-advisory-audit, check-rust-security-floors, check-postmerge-deploys, check-sidecar-shipped-routes
  - 찾는 방법: 지운 경로마다 `rg -l "<경로>" tests e2e`를 실행한다. 지운 기능만 검사하는 테스트는 지우고, 남은 기능을 함께 검사하는 테스트는 해당 단언만 지운다.
- Modify (설계 문서 8.5): `country.html`, `market.html`, `settings.html`, `live-channels.html`이 플러그인·데스크톱 진입점임을 확인해 지웠고, 웹 대시보드의 같은 기능은 `main.ts`의 쿼리 경로로 남는다고 적는다.

- [ ] **Step 1:** 삭제와 수정을 한다.
- [ ] **Step 2:** `rg -n "src-tauri|pro-test|claude-plugin|vercel\.json|middleware\.ts|nixpacks|railway-services|plugin\.html|embed\.html|verify\.html|mcp-grant\.html|desktop-sign-in\.html" --glob "!docs/**" --glob "!*.md"`를 실행한다. 결과는 주석이나 문자열 설명뿐이어야 하고, 실제 import나 경로 사용은 0건이어야 한다.
- [ ] **Step 3:** `npm install`을 실행한다. lockfile 갱신이 성공해야 한다.
- [ ] **Step 4:** 단계 확인을 한다.
  - 커밋 메시지: `chore(personal): delete desktop app, SDKs, plugins, public pages and deploy configs`

### Task 7: 게이트웨이 단순화와 유료 기능 해제 (설계 5.2-(4), 8.1, 8.3)

**Files:**

- Modify: `server/gateway.ts`. `dispatch`(:1132~)를 다음 순서로 줄인다.
  1. `.md` twin(:1142-1160)
  2. CORS와 origin 검사(:1267-1323)
  3. 경로 찾기, POST→GET 호환, 404/405(:2200-2250)
  4. `validateGeneratedRequest`
  5. `bindCountryHistoryAccess(req, 365)`와 핸들러 호출(:2766-2800)
  6. 응답 헤더와 캐시 등급(:2850-3060)
  7. HEAD 처리(:3105-3131)
  - 지울 것
    - 사용량 이벤트·과금 확인(:1180-1260), 클라이언트 신뢰 헤더 제거(:1324-1404), 내부 MCP HMAC(:1406-1590)
    - 공개/사이드카/등급 플래그와 유료 등급 검사(:1596-1648), Clerk 세션(:1655-1671), API 키·사용자 키·데스크톱 키(:1682-2000)
    - 구독 확인(:1899-2075), 권한 확인(:2114-2190), idempotency(:2278-2300, :2723), 모든 속도 제한(:2308-2615), 직접 LLM 할당량(:2640-2715)
    - premium 경로를 `private` 캐시로 바꾸는 분기(:2887)
  - 쓰지 않게 된 import도 지운다.
  - `PREMIUM_RPC_PATHS` import(:589)를 지운다. 이 파일 자체는 브라우저가 아직 import하므로 작업 10에서 지운다.
- Modify (핸들러의 유료·할당량 호출)
  - `requirePremiumRpcAccess` 호출을 지운다
    - `aviation/v1/_shared.ts:74`, `forecast/v1/trigger-simulation.ts:59`, `military/v1/get-aircraft-details.ts:25`, `shipping/v2/route-intelligence.ts:45`
    - `shipping/v2/list-webhooks.ts:50`(:37의 `validateUserApiKey`도 지운다), `shipping/v2/register-webhook.ts:87`(:73도 지운다)
    - `scenario/v1/run-scenario.ts:29`, `scenario/v1/get-scenario-status.ts:130`: 반환값을 작업 소유자로 쓰므로 `PERSONAL_OWNER_ID`로 바꾼다.
  - `isCallerPremium(...)`의 분기를 "유료"쪽으로 고정하고 호출을 지운다
    - trade 4곳: `list-comtrade-flows.ts:30`, `get-us-import-duty.ts:563`, `get-tariff-trends.ts:314`, `get-bilateral-tariff.ts:440`
    - intelligence 2곳: `get-country-intel-brief.ts:355`, `deduct-situation.ts:115`
    - supply-chain 8곳: `get-bypass-options.ts:24`, `get-multi-sector-cost-shock.ts:89`, `get-country-chokepoint-index.ts:75`, `get-country-products.ts:214`, `get-country-cost-shock.ts:30`, `get-route-explorer-lane.ts:280`, `get-route-impact.ts:227`, `get-sector-dependency.ts:31`
  - 그 밖의 호출을 지운다
    - `news/v1/summarize-article.ts`: :140, :179, 속도 제한, :35 사용량
    - `market/v1/backtest-stock.ts:111`
    - `intelligence/v1/get-country-history.ts:38`: 항상 365일
    - 상류 보호용 `checkScopedRateLimit`: `cyber/v1/get-network-info.ts:55,60`, `aviation/v1/track-aircraft.ts:52`, `infrastructure/v1/search-place.ts:76,79`, `infrastructure/v1/reverse-geocode.ts:82`, `batch/v1/execute-batch.ts:32`
    - `news/v1/list-feed-digest.ts`, `news/v1/_lastgood-store.ts`의 `getUsageScope`: 사용자 범위 없이 동작하게 한다.
- Modify (남는 `api/` 진입점의 인증·제한 호출)
  - `api/chat-analyst.ts`: :184, :189, :213, :222, :273, :279, :311
  - `api/travel-risk-assessment.ts`: :21, :36, :40, :48
  - `api/latest-brief.ts`: :196, :201. 사용자 ID는 `PERSONAL_OWNER_ID`로 한다.
  - `api/brief/share-url.ts`: :84, :89
  - `api/brief/[userId]/[issueDate].ts`, `api/brief/public/[hash].ts`, `api/brief/carousel/...`의 서명 URL 검사
  - `api/ask.ts`: :198, :209
  - `api/health.js`: :6314의 `validateApiKey({forceKey:true})`
  - `api/bootstrap.js`: :377, :413, :565
  - `api/telegram-feed.js`: :253, :260, :267-268, :302, :336, :354
  - `validateApiKey` 또는 `checkRateLimit`을 import하는 나머지 진입점: `opensky.js`, `rss-proxy.js`, `seed-health.js`, `symbol-search.ts`, `x-feed.js`, `reverse-geocode`, `not-found.ts`, `security/report.js`, `youtube/live.js`, `_relay.js`, `api/v2/shipping/webhooks/*`
  - 앞 단계(개인 서버의 Basic 인증)가 유일한 출입 통제다.
- Create: `tests/gateway-personal.test.mts`

**Interfaces:**

- Consumes: `shared/personal-owner.js`의 `PERSONAL_OWNER_ID`(작업 5)
- Produces: `createDomainGateway(...)`의 시그니처는 그대로다. 인증 관련 옵션은 받기만 하고 무시한다(호출하는 쪽은 작업 8에서 정리한다).

- [ ] **Step 1: 실패하는 테스트 작성** (`tests/gateway-personal.test.mts`)
  - 쿠키, Authorization, API 키 헤더가 없는 요청을 준비한다.
  - `premium RPC runs its handler without credentials`: 원래 `PREMIUM_RPC_PATHS`에 있던 경로 2개(`/api/supply-chain/v1/get-country-cost-shock`, `/api/scenario/v1/run-scenario`)를 게이트웨이로 보낸다. 모의 핸들러가 1번 호출되고 응답은 200이어야 한다(Review Focus 1).
  - `no rate limit after many calls`: 같은 요청 200번이 모두 200이다.
  - `unknown route is 404`: 없는 경로는 404다.
- [ ] **Step 2:** `node --import tsx --test tests/gateway-personal.test.mts`를 실행한다. 401 때문에 FAIL해야 한다.
- [ ] **Step 3:** 게이트웨이, 핸들러, `api/` 진입점을 수정한다.
- [ ] **Step 4:** 같은 테스트를 실행해 PASS를 확인한다. 지운 단계를 검사하던 테스트는 지운다(예: gateway-*, premium-*, rate-limit-*, api-key-*, `tests/premium-paths-guard.test.mts`는 작업 10까지 둔다). 남은 동작을 검사하는 테스트는 고친다.
- [ ] **Step 5: 개인 서버에서 확인한다.**
  - 다음 호출이 모두 200이고 내용이 비어 있지 않아야 한다.
    - `get-country-cost-shock`(KR)
    - `run-scenario`(`hormuz-tanker-blockade`)와 그 상태 조회
    - `get-country-intel-brief`(KR)
    - 회복력 점수, `chat-analyst`(질문 1개)
  - `npm run collect:personal -- digest-notifications` 뒤 `/api/latest-brief`가 브리프를 돌려줘야 한다(설계 8.3).
- [ ] **Step 6:** 단계 확인을 한다. bootstrap 키가 기준선보다 늘 수 있다(전에는 유료라 빠지던 키). 늘어난 키가 원래 유료 데이터인지 확인하고, compare 결과의 `added`를 커밋 메시지에 적는다. 이 작업에 한해 `added`는 실패로 보지 않는다. 확인이 끝나면 `node scripts/local/baseline/capture.mjs --label base-unlocked`를 실행한다. 작업 8부터는 이것이 비교 기준이다. 시나리오와 테스트는 이미 `base`와 같음을 확인했으므로 기준을 바꿔도 비교가 약해지지 않는다.
  - 커밋 메시지: `feat(personal): open every premium route and reduce the gateway to routing`

### Task 8: 계정·결제·OAuth·MCP·알림 API와 서버 공용 모듈 삭제 (설계 5.2-(3)(4))

**Files:**

- Delete (`api/`)
  - 결제·계정: `create-checkout.ts`, `customer-portal.ts`, `pro-business-upgrade.ts`, `product-catalog.js`(+ test), `referral/`, `me/`, `user/`, `user-api-keys.ts`, `user-embed-keys.ts`, `user-prefs.ts`, `invalidate-user-api-key-cache.ts`, `desktop-auth/`, `desktop-key/`
  - OAuth·에이전트·MCP: `oauth/`, `oauth-authorization-server.ts`, `oauth-protected-resource.ts`, `agent-auth.ts`, `a2a.ts`, `mcp.ts`, `mcp/`, `mcp-proxy.ts`, `docs-mcp.ts`, `skills/`, `http-message-signatures-directory.ts`, `widget-agent.ts`, `internal/mcp-grant-context.ts`, `internal/mcp-grant-mint.ts`
  - 알림: `notify.ts`, `notification-channels.ts`, `notification-suppressions.js`, `slack/`, `discord/`, `channel-oauth-bind.ts`
  - 공개 사이트 부가 기능: `og-story.js`, `story.js`(+ tests), `md-twin.ts`, `embed/`, `download.js`, `cache-purge.js`, `analytics-health.js`(+ test), `seed-contract-probe.ts`
  - 보조 모듈: `_desktop-auth`, `_mcp-grant-hmac`, `_oauth-token`, `_convex-error`, `_product-catalog.generated`, `_idempotency.js`, `_notification-webhook-ssrf`, `_agent-metadata`, `_sentry-node`, `_www-authenticate.ts`, `_user-api-key.js`, `_api-key-rate-limit.js`, `_desktop-key-meter.js`, `_rate-limit.js`, `_upstash-ratelimit.js`, `_rate-limit-fallback.js`, `_usage-telemetry.js`
  - 이 목록은 작업 7 이후 남은 import가 없다는 전제다. 삭제 전에 `rg`로 다시 확인한다.
  - `api/wm-session.js`, `api/_session.js`, `api/_api-key.js`는 브라우저가 아직 세션을 만들므로 작업 10에서 지운다. `_sentry-edge.js`, `_sentry-common.js`도 작업 10에서 다룬다.
  - **남기는 것**: `telegram-feed.js`(데이터 소스), `api/giving/`(데이터 패널)
- Delete (`server/`)
  - `server/worldmonitor/leads/`, `server/worldmonitor/feedback/`(문의·버그 신고 양식), `server/_shared/agent-feedback.ts`
  - `server/_shared/`: `premium-check`, `pro-entitlement`, `entitlement-check`, `entitlement-coverage`, `embed-entitlement`, `embed-session`, `auth-session`, `user-api-key`, `api-key-rate-limit`, `account-rate-limit`, `rate-limit`, `direct-llm-quota`, `backtest-stock-quota`, `turnstile`, `channel-oauth-state`, `notify-fields`, `internal-auth`, `pro-mcp-gate`, `pro-mcp-token`, `mcp-internal-hmac`, `usage-identity`, `high-usage-alarm`, `desktop-key-principal`, `desktop-key-meter`, `idempotency`, `sub-request-admission`, `api-only-paths`, `embed-key`
  - `entitlement-check`를 import하는 `server/error-mapper.ts`, `_shared/ai-routing-policy.ts`, `_shared/travel-risk-export.ts`에서 그 의존을 지운다.
  - 의존을 지우는 방식: 권한 오류 타입은 쓰이는 곳이 없어지면 함께 지우고, 라우팅 정책은 사용자 대신 기본 정책을 쓴다.
- Delete: `scripts/generate-entitlement-crosswalk.mjs`와 `entitlement:crosswalk*` 스크립트. `scripts/lib/openapi-codegen.mjs`의 `entitlement-check`·`premium-paths` 읽기 부분을 지우되, OpenAPI 생성 자체는 남긴다.
- Delete: `scripts/company-monitoring-worker.mjs`, `scripts/lib/company-monitoring-*`, `company-monitoring:*` 스크립트와 테스트
  - 설계 문서 8.2에 다음을 추가한다(설계자 판단, 소유자가 고칠 수 있음). 회사 모니터링은 사용자가 지정한 회사를 X·Exa 유료 API로 살피는 사용자별 기능이고, 작업 선택·임대·기록을 Convex가 맡는다. 전 세계 공통 피드가 아니므로 데이터 폭 축소로 보지 않는다.
- Modify: `api/api-route-exceptions.json`, `api/bootstrap.js`, `api/health.js`에서 지운 진입점·키를 가리키는 항목을 지운다. health의 Convex checkout 점검(:5470)도 지운다.
- Delete (테스트): 지운 파일을 대상으로 하는 테스트(`tests/mcp-*`, `tests/oauth-*`, `tests/notify-*`, `tests/notification-*`, `tests/entitlement-*`, `tests/premium-check*`, `tests/rate-limit*`, `tests/leads-*`, `tests/feedback-*`, `server/__tests__`의 해당 파일 등). 지운 경로마다 `rg -l`로 찾는다.

- [ ] **Step 1:** 지울 파일마다 `rg -l "<모듈명>" api server src scripts shared tests`를 실행한다. 남는 파일에서 import하는 곳이 없어야 한다. 있으면 작업 7의 정리가 빠진 것이므로 그 호출을 먼저 지운다.
- [ ] **Step 2:** 삭제와 수정을 한다.
- [ ] **Step 3:** `npm run typecheck:api`를 실행한다. 오류가 0이어야 한다. 이 스크립트 안의 Convex 감사 두 개(`audit-convex-string-calls`, `sync-sentry-convex-probe-filters --check`)는 작업 10까지 둔다. 실패하면 지운 파일 참조만 정리한다.
- [ ] **Step 4:** 단계 확인을 한다.
  - 커밋 메시지: `chore(personal): delete account, billing, OAuth, MCP and notification APIs`

### Task 9: 브라우저 유료 잠금과 결제 화면 삭제 (설계 5.2-(5) 앞부분, 8.1)

**Files:**

- Modify
  - `src/config/panels.ts`
    - 31개 `premium:` 항목을 지운다.
    - `isPanelEntitled`(:1314)를 지우고 호출하는 곳은 항상 허용으로 바꾼다.
    - `isEntitled`·`getSecretState` import도 지운다. 이 import에 걸린 `boundary-ignore` 주석도 함께 지운다.
  - `src/components/Panel.ts`: 잠금과 유료 안내 경로(`showLocked`, `showGatedCta` :1230-1310)를 지운다.
- Delete (services)
  - `billing*.ts`, `_billing-error.ts`, `checkout*.ts`, `entitlement*.ts`, `hosted-checkout-url.ts`, `premium-fetch.ts`, `premium-denial.ts`, `premium-intent.ts`, `pro-*.ts`, `upgrade-flow.ts`, `referral*.ts`, `desktop-checkout-handoff.ts`, `panel-gating.ts`, `gates/`, `api-plan-limit-notices.ts`, `api-keys.ts`, `embed-keys.ts`, `mcp-clients.ts`, `team-dashboards.ts`, `audience-profile.ts`
- Delete (components): `ProBanner`, `ProPreviewSection`, `ProActivationChip`, `ProActivationInterstitial`, `premium-layer-gate`, `ExportGateControl`, `gate-icons`, `checkout-failure-banner`, `BusinessSeatsSection`, `EnterpriseSeatsSection`
- Delete (app): `src/app/pro-activation-controller.ts`, `src/app/free-tier-gate.ts`
- Modify (호출하는 곳)
  - `App.ts`(27곳), `data-loader`(25), `UnifiedSettings`(17), `panel-layout`(17), `search-manager`(13), `DeckGLMap`(11), 그 밖의 약 40개 파일
  - 정리 방식
    - `isProUser`, `isEntitled`, `hasFeature`, `hasTier`, `has*ForAccount`, `hasPremiumAccess`, `readPremiumAccessGrant`, `getPanelGateReason`, `enforceFreePanelLimit`, `role === 'pro'`, `planKey`를 쓰는 분기는 "허용된" 쪽만 남기고 조건을 지운다.
    - `premiumFetch(...)`는 같은 인자의 `fetch(...)`로 바꾼다.
    - `widget-store.ts:284`의 `isProUser`는 지우고, 호출하는 곳은 허용 쪽으로 바꾼다.
- Delete (테스트): 지운 모듈의 `tests/`, `tests/dom/` 테스트. 패널 잠금을 검사하던 DOM 테스트는 "잠금이 보이지 않는다"는 단언으로 고친다.

- [ ] **Step 1: 테스트 작성** (`tests/dom/personal-unlocked-panels.test.mts`, 기존 `tests/dom/` 하네스 사용)
  - `formerly premium panels render without a lock`: 원래 `premium: 'locked'`이던 패널 3개(공급망 비용 충격, 시나리오, 회복력)를 만들면 잠금 오버레이 요소가 0개다.
- [ ] **Step 2:** `npm run test:dom`을 실행한다. 새 테스트가 FAIL해야 한다.
- [ ] **Step 3:** 삭제와 수정을 한다.
- [ ] **Step 4:** `npm run test:dom`, `npm run typecheck`, `npm run lint:boundaries`를 실행한다. 새 테스트는 PASS해야 하고, 오류 수는 기준선 이하여야 한다.
- [ ] **Step 5:** `.agents/skills/verify-worldmonitor/SKILL.md`를 따라 개인 서버 화면에서 확인한다. 세 패널이 잠금 없이 데이터를 그리고, "Pro"·"업그레이드" 문구가 화면에 없어야 한다.
- [ ] **Step 6:** 단계 확인을 한다.
  - 커밋 메시지: `feat(personal): remove premium locks and billing UI from the dashboard`

### Task 10: 로그인·Convex·세션·텔레메트리·데스크톱 분기 삭제와 `convex/` 삭제 (설계 5.2-(5) 나머지, 5.2-(1)의 convex)

**Files:**

- Delete (로그인)
  - services: `clerk.ts`, `auth-state.ts`, `clerk-desktop-relay.ts`, `sign-up-resume.ts`, `sign-in-dismissal.ts`, `passkeys.ts`, `passkey-offer-*.ts`, `account-deletion.ts`, `account-operation.ts`, `browser-key-session.ts`, `desktop-browser-sign-in.ts`, `desktop-sign-in-page.ts`, `desktop-cloud-auth.ts`, `desktop-cloud-access-hint.ts`
  - components: `AuthHeaderWidget.ts`, `AuthLauncher.ts`, `PasskeyOfferPrompt.ts`, `SignUpResumeOverlay.ts`
  - app: `account-auth-handoff.ts`, `passkey-offer-boot.ts`, `passkey-offer-controller.ts`, `tier-preference-handoff.ts`
  - `UnifiedSettings.ts`의 계정·로그인 줄
- Delete (Convex 브라우저 코드): `src/services/convex-client.ts`. `followed-countries.ts`는 Convex 동기화 부분을 지우고 로컬 저장만 남긴다.
- Delete (세션)
  - `src/services/wm-session.ts`, `api/wm-session.js`(+ test), `api/_session.js`, `api/_api-key.js`
  - `_api-key.js`를 import하던 곳은 작업 7에서 호출을 지웠다. 남은 `_crypto.js` 사용을 확인한다.
  - `src/services/runtime.ts`의 `installWebApiRedirect`(:486-645)에서 세션 자격 첨부를 지운다.
  - `src/shared/premium-paths.ts`, `shared/selfhost-relay-paths.js`의 유료 경로 목록, `scripts/enforce-premium-fetch.mjs`, 관련 테스트(약 30개, `tests/premium-paths-guard.test.mts` 등)
  - `scripts/personal-server.mjs`의 `WM_SESSION_SECRET` 요구(:109)와 `.env.example`의 그 항목
- Delete (PWA·Sentry·분석·RUM)
  - `src/bootstrap/sw-update.ts`, `src/services/pwa-install.ts`, `src/services/push-notifications.ts`, `src/pwa.d.ts`, `vite.config.ts`의 `VitePWA`(:3, :1127)
  - `src/bootstrap/sentry-init.ts`, `sentry-defer.ts`, `sentry-allow-urls.ts`, `fetch-failure-attribution.ts`, `vite.config.ts`의 `sentryVitePlugin`(:1070), `api/_sentry-edge.js`, `api/_sentry-common.js`와 그 호출
  - `src/services/analytics.ts`, `analytics-collector-transport.ts`, `secondary-startup.ts:90`의 `@vercel/analytics`, `src/bootstrap/`의 `debugbear-rum`, `lcp-*`, `cls-*`, `inp-report`, `web-vitals-utils`, `bootstrap-transfer-rum`
  - `platform-ua.ts`는 다른 곳이 쓰면 남긴다.
  - 호출 정리 방식: `enqueueSentryCall(...)`과 `track*(...)` 호출 문장을 지운다. 대체 모듈은 만들지 않는다.
- Delete (데스크톱 분기)
  - `src/services/tauri-bridge.ts`, `config/desktop-runtime.ts`, `services/desktop-runtime.ts`, `app/desktop-updater.ts`, `src/services/desktop-readiness.ts`
  - `runtime.ts`의 `installRuntimeFetchPatch`(:399-470)와 보조 함수(:43-66, :292-391)
  - 51개 파일에 흩어진 `isDesktopRuntime()`, `__TAURI` 분기(147곳)는 웹 쪽만 남긴다.
  - `src/components/RuntimeConfigPanel.ts`가 데스크톱 전용이면 지운다.
- Delete: `convex/`, `vitest.config.mts`
  - 스크립트: `test:convex*`, `audit:convex-string-calls`, `*sentry-convex-probe-filters`, `audit:sentry-resolve-pins`, `audit:dodo-catalog`
  - `typecheck:api`에서 Convex 감사 두 개를 빼고, `typecheck:all`도 정리한다.
  - `package.json`의 `"convex"` 블록(:357)
  - 의존성: `convex`, `convex-test`, `@dodopayments/convex`, `@clerk/clerk-js`, `@vercel/analytics`, `vite-plugin-pwa`, `@sentry/*`, `workbox-*`. 각각 `rg`로 남은 사용이 없음을 확인한 뒤 지운다.
  - `vite.config.ts`의 Clerk 청크(:39-58, :1427)
- Modify: `server/__tests__/`에서 지운 모듈을 쓰지 않는 테스트는 vitest 없이 돌도록 `tests/*.test.mts`로 옮긴다(`node:test`). 작업 3에서 고친 summarize-article 두 파일도 포함한다. 나머지는 지운다.
- Modify: `typecheck.yml`, `test.yml`에서 vitest·convex 관련 남은 단계를 지운다.

- [ ] **Step 1:** 삭제와 수정을 한다.
- [ ] **Step 2:** `rg -n "convex|@clerk|@sentry|vite-plugin-pwa|__TAURI|isDesktopRuntime|wm-session|premium-paths" src server api scripts shared --glob "!*.md"`를 실행한다. 결과는 0건이거나 설명 주석뿐이어야 한다.
- [ ] **Step 3:** `npm install`, `npm run typecheck`, `npm run typecheck:api`, `npm run lint:boundaries`, `npm run test:dom`을 실행한다. 오류 수가 기준선 이하여야 한다.
- [ ] **Step 4:** verify-worldmonitor 스킬로 화면을 확인한다.
  - 대시보드가 로그인 없이 뜬다.
  - 콘솔에 `/api/wm-session` 404나 Clerk·Sentry 요청이 없다.
  - 지도와 뉴스 패널이 그려진다.
- [ ] **Step 5:** 단계 확인을 한다.
  - 커밋 메시지: `chore(personal): remove sign-in, Convex, sessions, telemetry and desktop branches`

### Task 11: 남은 참조 정리, 문서 갱신, 1단계 마감 (설계 5.3-8, 5.4 완료 조건)

**Files:**

- Modify
  - `AGENTS.md`
    - 첫 문단을 "개인용 대시보드 + 로컬 API + 내장 저장소 + 수집기"로 바꾼다.
    - "Landmarks"의 `PREMIUM_RPC_PATHS`·`validateApiKey` 행을 지운다.
    - 테스트 표의 `test:convex`·`test:sidecar` 행을 지운다.
  - `ARCHITECTURE.md`: Vercel, Railway, Tauri, Convex, Clerk 절을 지우거나 개인용 구성으로 바꾼다. CI 표는 작업 4·10과 맞춘다.
  - `CONTRIBUTING.md`: 워크트리·PR 관련 절을 지우고, 테스트 명령을 남은 것으로 맞춘다.
  - `README.md`: 개인용 실행 방법(build, start, collect, tui)과 필요한 키를 적는다.
  - `SELF_HOSTING.md`: 개인 서버만 남긴다.
  - `.env.example`: 지운 기능의 키(Clerk, Convex, Dodo, Resend, Telegram 발송, Sentry, Umami, Vercel)를 지운다.
- Modify: `scripts/docs-stats.mjs`의 `DOC_VALIDATORS` 중 지운 문서나 기능을 가리키는 것(MCP Apps docs, plan/layer entitlement copy)을 지운다.
- Modify (설계 문서)
  - 5.2의 각 범주가 지워졌는지 확인한다. 남긴 것이 있으면 이유를 적는다. 예: `proto` 안의 leads·feedback·company-monitoring 정의는 생성 도구가 없어 2단계로 넘긴다.
  - 기준선과 최종 줄 수(`loc.json` 두 개)를 적는다.
  - 상태를 "1단계 완료"로 바꾼다.

- [ ] **Step 1:** `rg -n "worldmonitor\.app/(pro|checkout|mcp)|clerk|convex|tauri|railway|vercel" --glob "*.md" --glob "!docs/superpowers/**" --glob "!CHANGELOG.md" --glob "!blog-site/**"`를 실행한다. 결과마다 지우거나 고친다. `docs/`의 공개 문서는 2단계에서 정하므로 이번에는 손대지 않는다.
- [ ] **Step 2:** 문서를 수정하고 `npm run docs:check`와 `git diff --check`를 실행한다. 둘 다 PASS해야 한다.
- [ ] **Step 3:** `node scripts/local/baseline/capture.mjs --label final`을 실행하고, `compare.mjs base-unlocked final`과 `compare.mjs base final`을 둘 다 실행한다. 앞의 것이 `PASS`여야 한다. 뒤의 것에서는 `added`가 작업 7에서 기록한 키뿐이어야 한다.
  - 시나리오 결과가 같다.
  - 새 실패 테스트가 없다.
  - `removed` 키는 모두 지운 기능의 것이다. 목록을 설계 문서에 적는다.
- [ ] **Step 4:** 단계 확인을 한다.
  - 커밋 메시지: `docs(personal): close phase 1 of the three-layer simplification`
