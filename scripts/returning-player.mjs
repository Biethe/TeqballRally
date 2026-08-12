/**
 * Make a page look like a player who has been here before.
 *
 * The first launch of the game goes straight into the coached lesson and
 * offers no title screen, which is the point of it — but every harness in this
 * directory drives the game from that title screen, and a fresh browser
 * context is, correctly, a first launch. Seeding the preference is what a
 * returning player *is*, so this is not a special test mode: it is the second
 * launch.
 *
 * Runs before any of the page's own scripts, so the game reads it at boot.
 */
export async function asReturningPlayer(page) {
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem("teqopen.prefs");
      const prefs = raw ? JSON.parse(raw) : {};
      localStorage.setItem("teqopen.prefs", JSON.stringify({ ...prefs, coached: true }));
    } catch {
      // Private mode: the harness will simply see the lesson, and say so.
    }
  });
}

/**
 * Make a page look like a player who has won something.
 *
 * Characters unlock on trophies (UNLOCK_AT in src/progress.ts), so a brand new
 * profile owns exactly one of them and the select carousel has nothing to move
 * to. A harness that needs two players to look different therefore has to be
 * driving someone who has got somewhere — otherwise it is asserting about a
 * roster of one, which proves nothing about whose character is whose.
 *
 * Like `asReturningPlayer`, this is not a test mode: a player with 400 trophies
 * is an ordinary thing to be. The store reads defensively, so seeding the two
 * fields the unlock actually depends on is enough.
 */
export async function withFullRoster(page, best = 400) {
  await page.addInitScript((value) => {
    try {
      const raw = localStorage.getItem("teqopen.career");
      const career = raw ? JSON.parse(raw) : {};
      localStorage.setItem(
        "teqopen.career",
        JSON.stringify({ ...career, best: value, trophies: value })
      );
    } catch {
      // Private mode: the run will see one character and fail saying so.
    }
  }, best);
}
