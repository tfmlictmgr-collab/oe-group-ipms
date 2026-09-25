import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Join a Realtime channel AS THE SIGNED-IN USER, or not at all.
 *
 * ⚠️ WHY THIS EXISTS. Realtime decides who may see a changed row from the role
 * recorded when the channel JOINS. The browser client hands the session token
 * to the live connection asynchronously, and a channel created during first
 * render could join before it arrived — recorded as `anon`. A token sent later
 * updates the socket, not that recorded subscription. On production (25 Sept
 * 2026) every dashboard subscription was `anon`: the board said "Live", and no
 * request or notification ever arrived without a reload — and because the
 * policies' functions were not executable by `anon`, those subscriptions also
 * broke the stream for everyone else (0302).
 *
 * So: read the session, put its token on the connection, THEN join. With no
 * session, join nothing — an unsigned subscription can see no row anyway, and
 * `AutoRefresh` still keeps the page current.
 *
 * Returns a cleanup function for a `useEffect`.
 */
export function joinAsUser(
  supabase: SupabaseClient,
  build: () => RealtimeChannel,
  onJoinState?: (joined: boolean) => void
): () => void {
  let channel: RealtimeChannel | null = null;
  let cancelled = false;

  (async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (cancelled) return;
    if (!token) {
      console.warn("Live updates are off: this page has no signed-in session to join with.");
      onJoinState?.(false);
      return;
    }
    await supabase.realtime.setAuth(token);
    if (cancelled) return;
    channel = build();
  })();

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}
