import type Ink from "@/terminal-runtime/host/runtime-session.js";

class InkInstanceMap extends Map<NodeJS.WriteStream, Ink> {
  everMounted = false;

  override set(stream: NodeJS.WriteStream, instance: Ink): this {
    this.everMounted = true;
    return super.set(stream, instance);
  }
}

const instances = new InkInstanceMap();
export default instances;
