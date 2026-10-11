import { AssistantGreeting } from "./AssistantGreeting";
import { EngineProgress } from "./EngineProgress";
import { useEngineAutopilot } from "./useEngineAutopilot";
import { useSpeechCancel } from "@/lib/voice/useSpeech";
import "./assistantCards.css";

/* What the assistant does by itself when the app opens: get its local engine
   ready (and say how far it is) and say hello. It also owns the two things
   that end speech anywhere in the app: Esc and a change of page. Loaded after
   the first paint (AppShell), with the words it reads. */
export default function AssistantStartup() {
  useEngineAutopilot();
  useSpeechCancel();
  return (
    <div className="acard-stack">
      <EngineProgress />
      <AssistantGreeting />
    </div>
  );
}
