# 프론트 경량화 가 단계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드 로드와 상호작용 지연을 재는 장치를 만든다. 기준선을 잰 뒤 3D 지구본과 평면 지도의 기울이기·회전을 없애고 다시 잰다. 그 결과로 주인과 성공 기준을 확정한다.

**Architecture:** 측정 장치는 둘로 나뉜다.

- 순수 통계·판정 모듈: `scripts/perf/perf-stats.mjs`. 단위 테스트한다.
- Playwright 실행기: `scripts/perf-personal.mjs`. 실행 중인 개인 서버(127.0.0.1:3000)를 잰다.

3D 제거는 렌더러, 전환 UI, 에이전트 인터페이스, 의존성, 정적 자산을 함께 지운다. 데스크톱은 DeckGL 평면 지도, 모바일은 SVG 지도만 남긴다.

**Tech Stack:** TypeScript(브라우저), Node 24 ESM 스크립트, Playwright(chromium), Chrome DevTools Protocol(CPU 감속, 힙), vitest(DOM 테스트), `node --import tsx --test`(단위 테스트).

**Spec:** `docs/superpowers/specs/2026-11-21-frontend-performance-design.md`

## Global Constraints

- Node 24 경로: `export PATH="/c/Users/tkddl/AppData/Local/Programs/node-v24.22.3-win-x64:$PATH"`.
- 커밋과 푸시:
  - main에 바로 커밋하고 `origin`에 푸시한다. `upstream`에는 푸시하지 않는다. `--no-verify`는 쓰지 않는다.
  - 모든 커밋은 아래 두 줄로 끝낸다.
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
    `Claude-Session: https://claude.ai/code/session_01AjhE6vfRCcusEi77VTyzp2`
- CI 기준:
  - Linux Test 워크플로의 실패 테스트 이름 집합을 기준 실행과 비교한다. 새로 깨지는 테스트는 0개여야 한다.
  - 기준 실행은 Test 44758792905(head 16edfc5db)이고, 실패는 37개다.
  - 비교할 때는 `gh run view <id> -R tkddls8848/worldmonitor --log`에서 `✖`·`not ok` 이름을 뽑는다.
- 매 커밋은 `npm run typecheck`, `npm run lint:boundaries`가 0 오류여야 한다. 번들이 바뀌면 `npm run bundle:check`도 통과해야 한다.
- 비밀 값: `.env.local` 값(인증 정보, 키)은 출력하거나 커밋하지 않는다.
- 측정 조건:
  - 측정 중에는 수집기(`collect:personal`)를 돌리지 않는다.
  - 비교하는 두 측정은 같은 서버 실행 안에서 연달아 잰다.
- 개선 판정: 아래 두 조건을 모두 만족할 때만 "효과 있음"이다.
  - 해당 지표의 중앙값이 10% 이상 좋아진다.
  - 개선 폭이 두 측정 중 큰 쪽의 흩어짐(최댓값 − 최솟값)보다 크다.
- 3D 제거는 주인 결정이다. 측정 결과와 상관없이 유지한다.
- 실행 위치와 서버:
  - 메인 체크아웃 `C:\Users\tkddl\orca\worldmonitor`의 main에서 작업한다.
  - 서버는 `npm run build:personal` 후 `npm run start:personal`로 띄운다. 주인이 재시작을 허락했다.
  - 서버를 끌 때는 3000번 포트를 쥔 프로세스와 그 자식 프로세스를 모두 끈다.
- 금지 명령: 메인 체크아웃에서 `git reset --hard`, `git checkout -- .`, `git stash`, `git worktree`는 쓰지 않는다.
- Windows에서만 실패하는 테스트(줄바꿈, 경로 구분자)는 진짜 LF 트리에서 확인한다.
  - 트리 만들기: `git -c core.autocrlf=false archive <sha> | tar -x -C <dir>`
  - node_modules 연결은 PowerShell에서 한다: `cmd /c mklink /J <dir>\node_modules C:\Users\tkddl\orca\worldmonitor\node_modules`

## Review Focus

1. 저장된 지도 선호값이 `globe`(이전 3D 선택)인 데스크톱 브라우저: DeckGL 평면 지도가 오류 없이 뜬다. 빈 지도나 예외가 나면 안 된다. → Task 4 Step 1
2. 같은 선호값을 가진 모바일·저사양 브라우저: SVG 지도가 뜬다. → Task 4 Step 1
3. 에이전트나 WebMCP가 지구본·`3d` 렌더러를 요청할 때: `globe_unavailable` 거부 결과를 돌려준다. 조용히 평면으로 바꾸지 않는다. → Task 4 Step 1
4. 렌더러 목록에서 `globe`가 빠져도 모든 지도 레이어는 `deck` 또는 `svg` 중 하나 이상에서 보인다. 쓸 수 없게 되는 레이어가 없어야 한다. → Task 4 Step 1
5. 측정 중 조작 결과가 끝내 나타나지 않을 때: 0ms나 생략이 아니라 `failed`로 기록한다. 비교에서도 개선으로 치지 않는다. → Task 1 Step 1

---

### Task 1: 측정 통계·판정 모듈

**Files:**

- Create: `scripts/perf/perf-stats.mjs`
- Test: `tests/perf-stats.test.mjs`

**Interfaces:**

- Produces:
  - `summarize(samples: Array<number|null>) -> { median: number|null, min: number|null, max: number|null, runs: number, failed: number }`
    - `null`은 실패한 측정이다. `failed`로 센다.
    - 성공한 값이 없으면 `median`, `min`, `max`는 모두 `null`이다.
  - `isImprovement(before: Summary, after: Summary, { minRatio = 0.10 } = {}) -> boolean`
    - 판정 규칙은 Global Constraints와 같다.
    - 낮을수록 좋은 지표 기준이다. `after.failed > 0`이거나 어느 쪽 `median`이라도 `null`이면 `false`다.
  - `compareReports(a: Report, b: Report) -> Array<{ metric: string, before: Summary, after: Summary, changePct: number|null, improved: boolean }>`
    - `Report`는 `{ label, createdAt, config, metrics: { [metricName]: Summary } }`이다.
    - 두 보고서에 모두 있는 지표만 비교한다.

- [ ] **Step 1: Write the failing test** — `tests/perf-stats.test.mjs`
  - `summarize([30, 10, 20, null, 40])`는 `{ median: 25, min: 10, max: 40, runs: 5, failed: 1 }`이다. 짝수 개면 가운데 두 값의 평균이다.
  - `summarize([null, null])`는 `{ median: null, min: null, max: null, runs: 2, failed: 2 }`이다.
  - before `{median:100,min:95,max:105}`, after `{median:85,min:83,max:88}`이면 `isImprovement`는 `true`다. 15% 개선이고, 폭 15가 흩어짐 10보다 크다.
  - after `{median:92,min:80,max:104}`이면 `false`다. 8% 개선에 그친다.
  - before `{median:100,min:60,max:140}`, after `{median:85,min:84,max:86}`이면 `false`다. 폭 15가 흩어짐 80보다 작다.
  - after에 `failed: 1`이 있으면 `false`다.
  - `compareReports`는 한쪽에만 있는 지표를 빼고, `changePct = (after-before)/before*100`을 소수 첫째 자리로 반올림한다.
- [ ] **Step 2: Run to verify it fails**
  - Run: `node --import tsx --test tests/perf-stats.test.mjs`
  - Expected: FAIL (module not found)
- [ ] **Step 3: Implement `summarize`, `isImprovement`, `compareReports`** in `scripts/perf/perf-stats.mjs`. 순수 함수로 짜고 의존성은 두지 않는다.
- [ ] **Step 4: Run to verify it passes**
  - Run: `node --import tsx --test tests/perf-stats.test.mjs`
  - Expected: PASS
- [ ] **Step 5: Commit** — `feat(perf): add the measurement statistics and keep-or-revert rule`

### Task 2: 측정 실행기 `perf:personal`

**Files:**

- Create: `scripts/perf-personal.mjs`
- Modify: `package.json` scripts. `"perf:personal": "node scripts/perf-personal.mjs"`를 추가한다.
- Test: `tests/perf-personal-args.test.mjs`

**Interfaces:**

- Consumes: Task 1의 `summarize`, `compareReports`
- Produces:
  - CLI
    - `npm run perf:personal -- --label <name> [--runs 5] [--cpu 1|4]`: 측정해서 `.personal/perf/<name>.json`(Report)을 쓴다.
    - `npm run perf:personal -- --compare <labelA> <labelB>`: 비교표를 출력하고 `improved` 열을 보여 준다.
  - export `parseArgs(argv: string[]) -> { mode: 'measure'|'compare', label?, runs, cpu, compare?: [string, string] }`
    - 기본값은 `runs=5`, `cpu=1`이다.
    - label은 `^[a-z0-9-]+$`만 허용한다. 그 밖의 값이면 Error를 던진다.

지표 이름은 이 목록으로 고정한다. 모두 밀리초이고, 바이트·메가바이트 지표만 단위가 다르다.

- 로드, 캐시 없는 새 컨텍스트: `cold.fcp`, `cold.lcp`, `cold.mapReady`, `cold.panelsReady`, `cold.tbt`, `cold.jsBytes`, `cold.cssBytes`, `cold.heapMB`
- 로드, 같은 컨텍스트에서 다시 들어간 경우: `warm.fcp`, `warm.lcp`, `warm.mapReady`, `warm.panelsReady`, `warm.tbt`
- 상호작용: `<name>.inputToPaint`와 `<name>.resultVisible`
  - `<name>`은 `country`, `layer`, `panel`, `search` 중 하나다.
  - `inputToPaint`: Event Timing 항목 중 그 조작이 만든 가장 긴 `duration`
  - `resultVisible`: 입력을 보낸 시점부터 결과 요소가 보이고 다음 프레임이 그려질 때까지

측정 방법:

- 인증과 브라우저
  - 인증: `.env.local`의 `WM_PERSONAL_USERNAME`(기본값 `owner`)과 `WM_PERSONAL_PASSWORD`를 `httpCredentials`로 넘긴다. 값은 출력하지 않는다. `.env.local`은 `scripts/_env-file.mjs`의 `loadEnvFile`로 읽는다.
  - 브라우저: chromium, headless, 뷰포트 1600x1000(데스크톱 DeckGL 경로).
  - `--cpu 4`이면 CDP `Emulation.setCPUThrottlingRate { rate: 4 }`를 건다.
- 측정 시작 전 준비: `addInitScript`로 PerformanceObserver를 건다.
  - 대상 항목: `paint`, `largest-contentful-paint`, `longtask`, `event`(`durationThreshold: 16`, buffered)
  - 모은 항목은 `window.__wmPerf`에 쌓는다.
- 로드 지표의 정의
  - `mapReady`: 지도 캔버스(DeckGL/MapLibre canvas)가 보이고 첫 프레임을 그린 시점
  - `panelsReady`: 첫 화면에 보이는 패널들의 로딩 표시가 모두 사라진 시점
  - `tbt`: FCP부터 `panelsReady`까지 긴 작업마다 `duration-50`을 더한 값
  - 바이트: Resource Timing의 `transferSize`를 JS와 CSS로 나눠 합한다.
  - 힙: CDP `Performance.getMetrics`의 `JSHeapUsedSize`
- 상호작용 조작과 결과 요소. 셀렉터는 구현자가 정한다.
  - `country`: CII 패널의 첫 `.cii-country` 클릭 → 국가 패널 또는 국가 브리프가 보임
  - `layer`: 지도 레이어 목록에서 켜져 있지 않은 레이어 하나의 `.layer-toggle input` 클릭 → 체크 상태 반영, 지도 다시 그리기
  - `panel`: 탭이 있는 패널의 다른 탭 클릭 → 그 탭 내용이 보임
  - `search`: `Meta+K`(Windows는 `Control+K`)로 검색 창을 열고 `korea` 입력 → 결과 목록이 보임
  - 설계서의 다섯 번째 조작(대시보드 변형 전환)은 재지 않는다. 개인 빌드는 `VITE_VARIANT=full`로 고정돼 있어 쓰지 않는 경로이기 때문이다.
- 실패 처리와 반복
  - 결과 요소가 15초 안에 보이지 않으면 그 회차 값은 `null`이다(Review Focus 5).
  - 실행이 끝날 때 실패 수를 출력한다.
  - 조작마다 대시보드를 새로 연다. 앞 조작의 영향이 섞이지 않게 하기 위해서다.
  - 회차마다 같은 순서로 반복한다.

- [ ] **Step 1: Write the failing test** — `tests/perf-personal-args.test.mjs`
  - `parseArgs(['--label','baseline'])`은 `{mode:'measure',label:'baseline',runs:5,cpu:1}`이다.
  - `parseArgs(['--label','x','--runs','3','--cpu','4'])`는 runs 3, cpu 4다.
  - `parseArgs(['--compare','baseline','no-globe'])`는 `{mode:'compare',compare:['baseline','no-globe']}`이다.
  - `parseArgs(['--label','../x'])`와 `parseArgs([])`는 throw한다.
  - 모듈을 import해도 브라우저가 뜨지 않는다. CLI 진입은 `process.argv[1]` 가드 뒤에 둔다.
- [ ] **Step 2: Run to verify it fails**
  - Run: `node --import tsx --test tests/perf-personal-args.test.mjs`
  - Expected: FAIL
- [ ] **Step 3: Implement `scripts/perf-personal.mjs`.** 위 지표와 조작을 그대로 구현하고 package.json에 스크립트를 추가한다.
- [ ] **Step 4: Run the unit test** — Expected: PASS
- [ ] **Step 5: Smoke-run against the live server**
  - 서버가 떠 있지 않으면 `npm run build:personal` 후 `npm run start:personal`을 백그라운드로 띄운다.
  - Run: `npm run perf:personal -- --label smoke --runs 1`
  - Expected:
    - `.personal/perf/smoke.json`이 생긴다.
    - 로드 지표 13개와 상호작용 지표 8개가 모두 숫자다.
    - `failed`는 0이다. 실패가 있으면 셀렉터나 대기 조건을 고친다.
- [ ] **Step 6: Commit** — `feat(perf): add perf:personal to measure dashboard load and interaction latency`

### Task 3: 기준선 측정

**Files:** 없음. 결과는 `.personal/perf/`(gitignored)에 남고, 요약은 Task 6에서 문서에 적는다.

- [ ] **Step 1:** 현재 main(3D 포함)을 `npm run build:personal`로 빌드하고 서버를 다시 띄운다. 수집기는 돌리지 않는다.
- [ ] **Step 2:** Run `npm run perf:personal -- --label baseline --runs 5`
  - Expected: `baseline.json`이 생기고 모든 지표의 `failed`가 0이다.
- [ ] **Step 3:** Run `npm run perf:personal -- --label baseline-cpu4 --runs 5 --cpu 4`
  - Expected: `baseline-cpu4.json`이 생긴다.
- [ ] **Step 4:** 지표별 중앙값 가운데 가장 나쁜 5개를 기록해 둔다. Task 6 보고에 쓴다.

### Task 4: 3D 지구본 제거

**Files:**

- Delete:
  - `src/components/GlobeMap.ts`
  - `src/services/globe-render-settings.ts`
  - `src/utils/globe-zoom.ts`
  - `src/utils/globe-marker-budget.ts`
  - `src/bootstrap/globe-marker-probe.ts`
  - `src/types/globe-gl.d.ts`
  - `src/app/map-dimension-control.ts`
  - `public/textures/`. 지구본만 쓴다. 지우기 전에 rg로 다른 사용처가 없는지 확인한다.
  - 대상이 사라지는 테스트 `tests/dom/globe-*.test.mts` 5개
- Modify:
  - 지도 컨테이너: `src/components/MapContainer.ts`. 지구본 분기, `preferGlobe`, `isGlobeMode`, `globeMap`을 없앤다.
  - 레이어 정의: `src/config/map-layer-definitions.ts`. `RendererKind`에서 `'globe'`를 빼고 기본값을 `['svg','deck']`로 한다.
  - 앱 쪽 호출부: `src/app/search-manager.ts`, `src/app/search-selection-dispatcher.ts`, `src/app/event-handlers.ts`, `src/app/panel-layout.ts`, `src/app/agent-bus-applier.ts`
  - 기타 참조: `src/utils/focus-map.ts`, `src/config/geo-map.ts`, `src/components/Map.ts`, `src/services/preferences-content.ts`(2D/3D 설정 항목), `webmcp-map-layer-catalog`의 `'3d'` 값
  - 스타일과 번역: `src/styles/main.css`의 지구본 규칙, 모든 `src/locales/*.json`의 지구본 전용 문구 키(en과 나머지 언어에서 함께 뺀다)
  - 의존성과 문서: `package.json`에서 `npm uninstall globe.gl @types/three`, `docs/map-engine.mdx`와 `docs/zh/map-engine.mdx`(평면 전용으로 고침)
  - 지구본을 언급하는 나머지 테스트와 e2e 사양: 지구본 단언만 지우거나 평면 기준으로 고친다. 평면 동작을 지키는 단언은 약하게 만들지 않는다.
- Test: `tests/dom/map-no-globe.test.mts`(신규)

**Interfaces:**

- Produces:
  - `MapContainer` 생성자에서 `preferGlobe` 인자가 사라진다.
  - `RendererKind = 'svg' | 'deck'`
  - 에이전트 지도 차원 요청에서 `globe`/`3d`는 `globe_unavailable` 거부를 돌려준다.

- [ ] **Step 1: Write the failing test** — `tests/dom/map-no-globe.test.mts`
  - (RF1) `localStorage`의 지도 차원 선호 키에 `globe`를 넣고, 데스크톱 WebGL2 환경에서 MapContainer를 만들면 deck 렌더러다. 예외도 없다. 저장 키 이름은 지금 `map-dimension-control.ts`가 쓰는 것을 그대로 쓴다.
  - (RF2) 같은 선호값으로 모바일 폭(390px) 또는 WebGL 없는 환경이면 svg 렌더러다.
  - (RF3) 에이전트 버스에 지구본·`3d` 차원 요청을 보내면 결과는 `{ status: 'denied', reason: 'globe_unavailable' }`다.
  - (RF4) `map-layer-definitions`의 모든 레이어는 `renderers`에 `'deck'` 또는 `'svg'`가 하나 이상 있다. `'globe'`는 하나도 없다.
  - WebMCP 지도 레이어 카탈로그의 렌더러·필터 값에 `'3d'`가 없다.
- [ ] **Step 2: Run to verify it fails**
  - Run: `npx vitest run --config vitest.dom.config.mts tests/dom/map-no-globe.test.mts`
  - Expected: FAIL. RF3, RF4와 카탈로그 단언이 지금 코드에서 실패한다.
- [ ] **Step 3:** Files 목록대로 지우고 고친다.
  - 지운 뒤 지운 파일 이름(basename)을 `src tests e2e scripts docs`에서 rg로 찾는다. 남은 참조를 없애야 한다.
  - `three`를 import하는 다른 코드가 없는지 확인한다.
- [ ] **Step 4: Run to verify it passes**
  - Run:
    - `npx vitest run --config vitest.dom.config.mts tests/dom/map-no-globe.test.mts`
    - `npm run test:dom`
    - 지구본을 언급하던 node 테스트: `node --import tsx --test <해당 파일들>`
  - Expected: 신규 테스트가 PASS이고, 고친 테스트도 모두 PASS다.
- [ ] **Step 5: Checks**
  - `npm run typecheck`와 `npm run lint:boundaries`는 0 오류여야 한다.
  - 번들 예산
    - `npm run bundle:budgets`로 다시 만든다. 이 값은 `.env.local`이 없는 빌드 기준이어야 한다(`scripts/bundle-budgets.mjs` 주석 참조).
    - 진짜 LF 트리에서 `VITE_VARIANT=full ./node_modules/.bin/vite build` 후 `node scripts/bundle-budgets.mjs`를 돌리고, 결과 `scripts/shared/bundle-budgets.json`을 메인 체크아웃에 복사한다.
    - 그다음 같은 트리에서 `bundle:check`가 통과해야 한다.
- [ ] **Step 6: Commit** — `feat(map): remove the 3D globe renderer and the 2D/3D switch`

### Task 5: 평면 지도를 평면 전용으로

**Files:**

- Modify:
  - `src/components/DeckGLMap.ts:226,321-322,1277-1282,1348-1353`. `MapInteractionMode`와 `MAP_INTERACTION_MODE`를 없애고 `maxPitch: 0`, `pitchWithRotate: false`, `dragRotate: false`를 항상 적용한다.
  - `.env.example`: `VITE_MAP_INTERACTION_MODE` 줄을 뺀다.
  - `tests/browser-bundle-secret-guard.test.mts:104`: 목록에서 그 이름을 뺀다.
- Test: `tests/dom/map-no-globe.test.mts`에 한 케이스를 추가한다.

- [ ] **Step 1: Write the failing test.**
  - 내용: DeckGL 지도 초기화 옵션을 확인한다. 환경 변수와 상관없이 `maxPitch === 0`, `dragRotate === false`, `pitchWithRotate === false`여야 한다.
  - 방법: `import.meta.env.VITE_MAP_INTERACTION_MODE`를 `'3d'`로 stub해도 같아야 한다. stub에는 `vi.stubEnv`를 쓴다.
- [ ] **Step 2: Run** — Expected: FAIL
- [ ] **Step 3: Implement.** Files 목록대로 고친다.
- [ ] **Step 4: Run** the new test, `npm run test:dom`, `node --import tsx --test tests/browser-bundle-secret-guard.test.mts`
  - Expected: PASS
- [ ] **Step 5: Commit, push, CI gate**
  - Commit: `feat(map): keep the flat map flat (no tilt or rotation)`
  - Task 4와 함께 origin에 푸시한다.
  - CI Test 실행의 실패 이름 집합을 기준(44758792905)과 비교한다. 새 실패는 0개여야 한다.
  - 새 이름이 나오면 기준 sha의 LF 트리에서 원래 있던 실패인지 확인한다. 원래 있던 것이 아니면 고친다.

### Task 6: 3D 제거 후 측정과 주인 보고

**Files:**

- Modify: `docs/superpowers/specs/2026-11-21-frontend-performance-design.md`. 끝에 `## 8. 가 단계 결과`를 추가한다.

- [ ] **Step 1:** `npm run build:personal` 후 서버를 다시 띄운다. 수집기는 돌리지 않는다.
- [ ] **Step 2: 측정**
  - Run:
    - `npm run perf:personal -- --label no-globe --runs 5`
    - `npm run perf:personal -- --label no-globe-cpu4 --runs 5 --cpu 4`
  - Expected: 모든 지표의 `failed`가 0이다.
- [ ] **Step 3: 비교**
  - Run:
    - `npm run perf:personal -- --compare baseline no-globe`
    - `npm run perf:personal -- --compare baseline-cpu4 no-globe-cpu4`
  - 두 표를 기록한다.
- [ ] **Step 4: 실서버 기능 점검.** 헤드리스 Playwright에 인증 정보를 넘기고, 값은 출력하지 않는다.
  - 대시보드 로드
  - 401 응답 0건
  - 지도와 뉴스 표시
  - CII, 시나리오, Trip Assessment, 채팅 분석, 최신 브리프 동작
  - 설정에 2D/3D 전환이 없다
  - `localStorage`에 `globe`를 넣고 다시 열어도 평면 지도가 뜬다
- [ ] **Step 5: 결과 기록**
  - `## 8. 가 단계 결과`에 적을 내용:
    - 두 비교표(지표, 기준선, 3D 제거 후, 변화율)
    - 가장 느린 항목 5개
    - 6절 성공 기준의 제안 숫자. 조작 4종의 `resultVisible` 중앙값 목표와 로드 목표를 기준선 대비로 적는다.
  - Commit: `docs(perf): record the phase A measurements`
  - origin에 푸시한다.
- [ ] **Step 6: 멈추고 주인에게 보고.** 보고할 내용:
  - 비교표
  - 가장 느린 항목
  - 제안 목표 숫자
  - 나 단계에서 먼저 손댈 후보

  주인이 숫자를 확정하기 전에는 나 단계로 넘어가지 않는다.
