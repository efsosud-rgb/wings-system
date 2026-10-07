/**
 * The audio of a WhatsApp call, in the browser itself (native WebRTC, no
 * library). Meta's side is ICE-lite with public addresses, so no STUN or TURN
 * server is used (none of our addresses leave for a third party); the
 * browser is the full ICE agent and the DTLS client. Meta asks for one Opus
 * audio stream at 48 kHz with 20 ms packets and does not renegotiate, so the
 * description is made once, with the candidates gathered, and never changed.
 * See /root/relatorios/whatsapp-oficial/ligacao-tecnico.md (Meta's rules).
 */

export interface CallMedia {
  pc: RTCPeerConnection;
  stream: MediaStream;
  audio: HTMLAudioElement;
  setMuted: (muted: boolean) => void;
  close: () => void;
}

export class MicrophoneError extends Error {}

const GATHER_MS = 2_500;

export async function openCallMedia(): Promise<CallMedia> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    throw new MicrophoneError('O navegador não deu acesso ao microfone.');
  }
  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  const [track] = stream.getAudioTracks();
  if (!track) throw new MicrophoneError('Nenhum microfone encontrado.');
  const transceiver = pc.addTransceiver(track, { direction: 'sendrecv', streams: [stream] });
  // Opus first (and the DTMF events Meta also takes), when the browser lets us choose.
  const codecs = RTCRtpReceiver.getCapabilities?.('audio')?.codecs ?? [];
  const wanted = codecs.filter((c) => /opus|telephone-event/i.test(c.mimeType));
  if (wanted.length > 0 && 'setCodecPreferences' in transceiver) {
    try {
      transceiver.setCodecPreferences(wanted);
    } catch {
      // The browser's own order stays; Opus is the default everywhere.
    }
  }
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio.play().catch(() => undefined);
  };
  return {
    pc,
    stream,
    audio,
    setMuted: (muted) => stream.getAudioTracks().forEach((t) => (t.enabled = !muted)),
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
      pc.close();
      audio.srcObject = null;
    },
  };
}

/** Waits until the browser has its candidates (or a short limit: Meta accepts unknown ones). */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** Meta wants 20 ms Opus packets: say so in the description when the browser did not. */
export function withPtime(sdp: string): string {
  if (/^a=ptime:/m.test(sdp)) return sdp;
  return sdp.replace(/(\r\n)(m=audio[^\r\n]*\r\n)/, '$1$2a=ptime:20\r\n');
}

const localSdp = (pc: RTCPeerConnection) => withPtime(pc.localDescription?.sdp ?? '');

/** To call: the browser's offer, with its candidates. */
export async function makeOffer(media: CallMedia): Promise<string> {
  const offer = await media.pc.createOffer();
  await media.pc.setLocalDescription(offer);
  await gathered(media.pc);
  return localSdp(media.pc);
}

/** Meta's answer to our offer, from the webhook. */
export async function applyAnswer(media: CallMedia, sdp: string): Promise<void> {
  await media.pc.setRemoteDescription({ type: 'answer', sdp });
}

/** To pick up: the answer to the offer the person's phone made. */
export async function answerOffer(media: CallMedia, offerSdp: string): Promise<string> {
  await media.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await media.pc.createAnswer();
  await media.pc.setLocalDescription(answer);
  await gathered(media.pc);
  return localSdp(media.pc);
}
