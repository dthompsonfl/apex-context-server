import { Button } from "@/components/Button";
import { Panel } from "@demo/ui";
import("@/lib/format");
const format = require("@/lib/format");
function helperMemorySignal() { return format.formatTitle("apex"); }
export default function Page() { return Panel({ children: Button({label: helperMemorySignal()}) }); }
