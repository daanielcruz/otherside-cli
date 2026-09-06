let liveValue = 0;

export function readLiveOutputTokens(): number {
  return liveValue;
}

export function setLiveOutputTokens(value: number): void {
  liveValue = value;
}

export function addLiveOutputTokens(delta: number): void {
  setLiveOutputTokens(liveValue + delta);
}
