// Keep pulsing while launch/cancel control IO is pending. The Go watch allows 1s each
// for status and collect inside a 3s pulse budget; the host adds 1s transport margin.
// After a reply, transport margin + 500ms pacing < 3s helper idle < 3.5s watch join.
// A pulse's 4s host deadline + pacing < 10s supervisor lease. No autonomous renewals:
// host death starts cancellation within 10s of the last renewal (500ms to KILL,
// 5s bounded join). Helper control 6s < host control 7s; READY 6s < the fixed 10s
// launch gate. READY renewals never extend that gate. Cleanup has an overall 20s cap.
export const execTiming = {
  heartbeatInterval: "500 millis",
  heartbeatReply: "4 seconds",
  watchReady: "6 seconds",
  control: "7 seconds",
  watchObservation: "7 seconds",
  cleanup: "20 seconds",
  watchJoinMillis: 3500,
} as const;
