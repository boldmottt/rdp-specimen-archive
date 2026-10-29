/* RDP 시편 아카이브 — 화면 상태 저장 큐 (장바구니·제안서·저장된 검색)
 *
 * 왜 있나
 *   저장 요청이 오가는 동안(Cloudflare 를 거치면 수백 ms) 사용자가 폴더를 또 고치면
 *   응답이 도착하는 순간의 처리 때문에 그 변경이 조용히 사라지거나, 낡은 rev 로 자기 자신과
 *   409 가 났다. 그래서 ① 한 번에 하나만 보내고 ② 변경 세대(gen)를 비교한다.
 *
 * 이 파일은 DOM·fetch·localStorage 를 직접 쓰지 않는다 — 전부 주입받는다.
 *   그래야 tests/ui-sync.test.mjs 가 응답 시점을 마음대로 조절해 검사할 수 있다.
 *
 * 되돌리기: core.js 의 pushUiState/saveSmart 를 예전 직접 fetch 로 되돌리고 이 파일을 지우면 된다.
 */

/**
 * @param {object} io
 * @param {(body:object)=>Promise<{status:number,json:any}>} io.send  PUT 한 번
 * @param {()=>Promise<object>} io.fetchState  409 뒤 서버 상태 읽기(GET /api/ui 의 state)
 * @param {(withFolders:boolean)=>object} io.getBody  요청 본문 만들기
 * @param {(state:object)=>void} io.onAdopt  409 뒤 서버 상태를 받아들임
 * @param {(json:any)=>void} io.onRev  성공 응답의 새 rev 반영
 */
export function createUiSync({ send, fetchState, getBody, onAdopt, onRev }) {
  let gen = 0;          // 폴더 변경이 일어날 때마다 +1
  let inflight = false; // 지금 요청이 오가는 중인가
  let again = false;    // 오가는 동안 또 요청이 왔는가(끝나면 한 번 더)
  let dirty = false;    // 폴더가 바뀌어 아직 서버에 못 보냈는가

  const api = {
    /** 폴더를 바꿨다 — 다음 push 에 smartFolders 를 싣는다.
     *  요청이 오가는 중이면 끝난 뒤 한 번 더 보내도록 예약한다(변경이 사라지지 않게). */
    markDirty() { dirty = true; gen++; if (inflight) again = true; },
    isDirty: () => dirty,
    isInflight: () => inflight,

    async push() {
      if (inflight) { again = true; return; }     // 한 번에 하나만
      inflight = true;
      const sent = gen;
      const withFolders = dirty;
      try {
        const r = await send(getBody(withFolders));
        if (r.status === 409) {
          // 다른 곳에서 먼저 바꿨다 → 서버 것을 받아들이고, 장바구니만 다시 보낸다
          dirty = false;
          const state = await fetchState();
          onAdopt(state || {});
          again = true;
        } else if (r.status >= 200 && r.status < 300) {
          if (withFolders) onRev(r.json);
          // 보낸 뒤에 또 바뀌었으면(sent !== gen) dirty 를 남겨 다음 요청에 싣는다
          if (withFolders && sent === gen) dirty = false;
        }
      } catch (e) {
        if (withFolders) dirty = true;            // 네트워크 실패 — 다음에 다시 시도
      } finally {
        inflight = false;
        if (again) { again = false; await api.push(); }
      }
    },
  };
  return api;
}
