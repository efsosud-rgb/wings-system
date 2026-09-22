import { describe, expect, it } from 'vitest';
import { buildFfmpegCommand, collectAssetInputs } from './ffmpeg-command.js';
import type { AudioClip, MediaVisualClip, RenderPlan, TextVisualClip, CaptionVisualClip } from './plan.js';

const basePlan: RenderPlan = {
  width: 1080,
  height: 1920,
  fps: 30,
  background: '#000000',
  totalDurationSeconds: 10,
  visual: [],
  audio: [],
  unsupported: [],
};

const videoClip: MediaVisualClip = {
  where: 'faixa 1, clipe 1',
  kind: 'video',
  assetId: 'video-1',
  start: 0,
  length: 10,
  trim: 0,
  fit: 'crop',
  scale: 1,
  position: 'center',
  offsetX: 0,
  offsetY: 0,
  opacity: 1,
  transitionIn: 'none',
  transitionOut: 'none',
};

describe('collectAssetInputs', () => {
  it('gives a video clip and its own audio the same input index', () => {
    const plan: RenderPlan = {
      ...basePlan,
      visual: [videoClip],
      audio: [{ where: videoClip.where, assetId: 'video-1', start: 0, length: 10, trim: 0, volume: 1 }],
    };
    const inputs = collectAssetInputs(plan, { 'video-1': '/tmp/video.mp4' });
    expect(inputs).toEqual([{ assetId: 'video-1', kind: 'video', index: 0, path: '/tmp/video.mp4' }]);
  });

  it('gives an audio-only clip its own input, after the visual ones', () => {
    const plan: RenderPlan = {
      ...basePlan,
      visual: [videoClip],
      audio: [{ where: 'faixa 2, clipe 1', assetId: 'music-1', start: 0, length: 10, trim: 0, volume: 1 }],
    };
    const inputs = collectAssetInputs(plan, { 'video-1': '/tmp/v.mp4', 'music-1': '/tmp/m.mp3' });
    expect(inputs).toEqual([
      { assetId: 'video-1', kind: 'video', index: 0, path: '/tmp/v.mp4' },
      { assetId: 'music-1', kind: 'audio', index: 1, path: '/tmp/m.mp3' },
    ]);
  });
});

describe('buildFfmpegCommand — one video clip', () => {
  const plan: RenderPlan = { ...basePlan, visual: [videoClip] };
  const command = buildFfmpegCommand(plan, { 'video-1': '/tmp/video.mp4' }, {}, '/tmp/out.mp4', {
    videoBitrate: 8_000_000,
    audioBitrate: 192_000,
  });
  const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;

  it('declares one input and the background canvas', () => {
    expect(command.args.slice(1, 3)).toEqual(['-i', '/tmp/video.mp4']);
    expect(graph).toContain('color=c=#000000:s=1080x1920:d=10:r=30,format=yuva420p[base0]');
  });

  it('trims, fits, centers, and overlays for the clip\'s own window', () => {
    expect(graph).toContain('[0:v]trim=start=0:duration=10,setpts=PTS-STARTPTS,format=yuva420p,' +
      'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,pad=1080:1920:0:0:color=black@0.0,' +
      'colorchannelmixer=aa=1,setpts=PTS+0/TB[clip0]');
    expect(graph).toContain("[base0][clip0]overlay=0:0:enable='between(t,0,10)':eof_action=pass[acc1]");
    expect(graph).toContain('[acc1]format=yuv420p[vout]');
  });

  it('has no audio stream when nothing was mixed', () => {
    expect(command.args).not.toContain('[aout]');
    expect(command.args).not.toContain('-c:a');
  });

  it('maps the video output and encodes at the requested bitrate', () => {
    expect(command.args).toEqual(
      expect.arrayContaining(['-map', '[vout]', '-c:v', 'libx264', '-b:v', '8000000', '-pix_fmt', 'yuv420p']),
    );
    expect(command.args.at(-1)).toBe('/tmp/out.mp4');
  });
});

describe('buildFfmpegCommand — position, offset, scale, fade', () => {
  it('places a scaled, offset, bottomRight clip and fades it in', () => {
    const clip: MediaVisualClip = {
      ...videoClip,
      fit: 'cover',
      scale: 0.5,
      position: 'bottomRight',
      offsetX: 0.1,
      offsetY: -0.1,
      transitionIn: 'fadeFast',
    };
    const plan: RenderPlan = { ...basePlan, visual: [clip] };
    const command = buildFfmpegCommand(plan, { 'video-1': '/tmp/v.mp4' }, {}, '/tmp/out.mp4', {
      videoBitrate: 1,
      audioBitrate: 1,
    });
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;
    // 540x960 box (half the 1080x1920 canvas); bottomRight anchors it at
    // (540,960), then offset by +10% width and -10% height of the canvas.
    expect(graph).toContain('scale=540:960');
    expect(graph).toContain('pad=1080:1920:648:768:color=black@0.0');
    expect(graph).toContain('fade=t=in:st=0:d=0.5:alpha=1');
  });
});

describe('buildFfmpegCommand — image input', () => {
  it('loops a still image at the project\'s fps', () => {
    const clip: MediaVisualClip = { ...videoClip, kind: 'image', assetId: 'logo' };
    const plan: RenderPlan = { ...basePlan, visual: [clip] };
    const command = buildFfmpegCommand(plan, { logo: '/tmp/logo.png' }, {}, '/tmp/out.mp4', {
      videoBitrate: 1,
      audioBitrate: 1,
    });
    expect(command.args.slice(1, 6)).toEqual(['-loop', '1', '-framerate', '30', '-i']);
  });
});

describe('buildFfmpegCommand — text', () => {
  it('draws text without consuming an ffmpeg input', () => {
    const text: TextVisualClip = {
      where: 'faixa 1, clipe 2',
      kind: 'text',
      start: 1,
      length: 4,
      text: "It's fine",
      fontFamily: 'DejaVu Sans',
      fontSizePx: 40,
      color: '#ffffff',
      align: 'center',
      position: 'bottom',
      offsetX: 0,
      offsetY: 0,
      opacity: 1,
    };
    const plan: RenderPlan = { ...basePlan, visual: [text] };
    const command = buildFfmpegCommand(plan, {}, {}, '/tmp/out.mp4', { videoBitrate: 1, audioBitrate: 1 });
    expect(command.args).not.toContain('-i');
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain("drawtext=fontfile='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf':text='It\\'s fine':");
    expect(graph).toContain("enable='between(t,1,5)'");
  });
});

describe('buildFfmpegCommand — captions', () => {
  it('burns in an SRT file without registering it as a decode input', () => {
    const caption: CaptionVisualClip = {
      where: 'faixa 1, clipe 3',
      kind: 'caption',
      start: 0,
      length: 10,
      assetId: 'srt-1',
      fontFamily: 'DejaVu Sans',
      fontSizePx: 28,
      color: '#ffffff',
      backgroundColor: null,
    };
    const plan: RenderPlan = { ...basePlan, visual: [caption] };
    const command = buildFfmpegCommand(plan, {}, { 'srt-1': '/tmp/captions.srt' }, '/tmp/out.mp4', {
      videoBitrate: 1,
      audioBitrate: 1,
    });
    expect(command.args).not.toContain('-i');
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain("subtitles=filename='/tmp/captions.srt':force_style=");
    expect(graph).toContain('BorderStyle=1');
  });
});

describe('buildFfmpegCommand — audio mixing', () => {
  it('delays each clip to its start and mixes them all', () => {
    const audio: AudioClip[] = [
      { where: 'faixa 2, clipe 1', assetId: 'a', start: 0, length: 5, trim: 0, volume: 1 },
      { where: 'faixa 2, clipe 2', assetId: 'b', start: 5, length: 5, trim: 2, volume: 0.5 },
    ];
    const plan: RenderPlan = { ...basePlan, audio };
    const command = buildFfmpegCommand(plan, { a: '/tmp/a.mp3', b: '/tmp/b.mp3' }, {}, '/tmp/out.mp4', {
      videoBitrate: 1,
      audioBitrate: 1,
    });
    const graph = command.args[command.args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('[0:a]atrim=start=0:duration=5,asetpts=PTS-STARTPTS,volume=1,adelay=0|0:all=1[a0]');
    expect(graph).toContain('[1:a]atrim=start=2:duration=5,asetpts=PTS-STARTPTS,volume=0.5,adelay=5000|5000:all=1[a1]');
    expect(graph).toContain('[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[aout]');
    expect(command.args).toEqual(expect.arrayContaining(['-map', '[aout]', '-c:a', 'aac']));
  });
});
