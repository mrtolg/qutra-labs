import { AssistantGreeting } from "./AssistantGreeting";
import { EngineProgress } from "./EngineProgress";
import { useEngineAutopilot } from "./useEngineAutopilot";
import "./assistantCards.css";

/* What the assistant does by itself when the app opens: get its local engine
   ready (and say how far it is) and say hello. Loaded after the first paint
   (AppShell), with the words it reads. */
export default function AssistantStartup() {
  useEngineAutopilot();
  return (
    <div className="acard-stack">
      <EngineProgress />
      <AssistantGreeting />
    </div>
  );
}
