/** Opens the Meet in its own window beside the Wings, which stays where it is (deal or Agenda). */
export function openMeetBeside(url: string) {
  const width = Math.min(1100, Math.round(window.screen.availWidth * 0.55));
  const height = Math.round(window.screen.availHeight * 0.9);
  const left = window.screen.availWidth - width;
  window.open(
    url,
    'wings-meet',
    `popup,width=${width},height=${height},left=${left},top=0,noopener,noreferrer`,
  );
}
