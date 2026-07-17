export interface EncodedPcm {
  pcm: Buffer;
  level: number;
}

export class Pcm16Resampler {
  private readonly ratio: number;
  private samples: number[] = [];
  private position = 0;

  constructor(sourceRate: number, targetRate: number) {
    if (sourceRate <= 0 || targetRate <= 0) throw new Error("audio sample rates must be positive");
    this.ratio = sourceRate / targetRate;
  }

  push(input: Float32Array): EncodedPcm {
    let energy = 0;
    for (const sample of input) {
      const finite = Number.isFinite(sample) ? sample : 0;
      this.samples.push(finite);
      energy += finite * finite;
    }
    const output: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const a = this.samples[left] ?? 0;
      const b = this.samples[left + 1] ?? a;
      output.push(a + (b - a) * fraction);
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), this.samples.length);
    if (consumed > 0) {
      this.samples.splice(0, consumed);
      this.position -= consumed;
    }
    const pcm = Buffer.allocUnsafe(output.length * 2);
    for (let index = 0; index < output.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, output[index] ?? 0));
      pcm.writeInt16LE(Math.round(sample < 0 ? sample * 32768 : sample * 32767), index * 2);
    }
    // RMS in 16-bit sample units, normalized against 2000 with a sqrt curve
    // so quiet speech still spans the visualizer's full range.
    const rms = input.length > 0 ? Math.sqrt(energy / input.length) * 32768 : 0;
    return {
      pcm,
      level: Math.sqrt(Math.min(rms / 2000, 1)),
    };
  }
}
