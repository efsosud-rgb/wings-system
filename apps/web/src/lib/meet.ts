const besideFeatures = () => {
  const width = Math.min(1100, Math.round(window.screen.availWidth * 0.55));
  const height = Math.round(window.screen.availHeight * 0.9);
  const left = window.screen.availWidth - width;
  return `popup,width=${width},height=${height},left=${left},top=0`;
};

/** Opens the Meet in its own window beside the Wings, which stays where it is (deal or Agenda). */
export function openMeetBeside(url: string) {
  window.open(url, 'wings-meet', `${besideFeatures()},noopener,noreferrer`);
}

/**
 * The same window for a Meet that does not exist yet ("Reunião agora"): it must open inside the
 * click or the browser blocks it, and the link only comes once Google has created the event.
 * The caller sends it to the link with `location.replace`, or closes it. Null when blocked.
 */
export function openMeetBesideEmpty(): Window | null {
  const win = window.open('', 'wings-meet', besideFeatures());
  // What noopener does for openMeetBeside: the Meet never reaches back into the Wings.
  if (win) win.opener = null;
  return win;
}
