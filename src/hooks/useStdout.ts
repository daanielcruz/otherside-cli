export type StdoutHook = {
  stdout: NodeJS.WriteStream;
  write: (data: string) => void;
};

export function useStdout(): StdoutHook {
  return {
    stdout: process.stdout,
    write: (data: string) => {
      process.stdout.write(data);
    },
  };
}
