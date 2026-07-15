export type Props = {
  readonly count?: number;
};

export default function Newline({ count = 1 }: Props) {
  return <ink-text>{"\n".repeat(count)}</ink-text>;
}
