import { AssistantGreeting } from "./AssistantGreeting";
import { useEngineAutopilot } from "./useEngineAutopilot";

/* What the assistant does by itself when the app opens: get its local engine
   ready and say hello. Loaded after the first paint (AppShell), with the
   words it reads. */
export default function AssistantStartup() {
  useEngineAutopilot();
  return <AssistantGreeting />;
}
