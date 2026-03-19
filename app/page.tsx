export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 800, margin: "0 auto" }}>
      <h1>SSR Slack Receipt Bot</h1>
      <p>This app exposes Slack endpoints for receipt intake and team assignment.</p>
      <ul>
        <li><code>/api/slack/events</code> for Events API</li>
        <li><code>/api/slack/commands</code> for slash commands</li>
        <li><code>/api/slack/interactivity</code> for button actions</li>
      </ul>
      <p>Configure Slack and environment variables as described in the README.</p>
    </main>
  );
}
