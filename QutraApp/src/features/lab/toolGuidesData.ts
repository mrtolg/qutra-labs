import type { Locale } from "@/lib/i18n";
import type { CompleteText, ToolCatalogEntry } from "./toolCatalog";

export type PrivateLabTab = "catalog" | "playbooks" | "datasets";

export type LabText = CompleteText;

export interface ToolUsageGuide {
  goal: LabText;
  command?: string;
  inputs: LabText[];
  steps: LabText[];
  expected: LabText[];
  boundary: LabText;
}

export interface LabPlaybook {
  id: string;
  title: LabText;
  summary: LabText;
  toolIds: string[];
  output: LabText;
}

export interface PrivateLabCopy {
  title: string;
  subtitle: string;
  catalog: string;
  playbooks: string;
  datasets: string;
  installed: string;
  verified: string;
  changed: string;
  availableTools: string;
  search: string;
  allCategories: string;
  allInstallations: string;
  installedOnly: string;
  missingOnly: string;
  tool: string;
  category: string;
  purpose: string;
  status: string;
  actions: string;
  guide: string;
  openGuide: string;
  openNative: string;
  openSource: string;
  addTask: string;
  taskCreated: string;
  verifiedNative: string;
  identityChanged: string;
  notRegistered: string;
  noMatch: string;
  selectTool: string;
  selectToolHint: string;
  starterWorkflow: string;
  commandPreview: string;
  commandUnavailable: string;
  requiredInputs: string;
  workflowSteps: string;
  expectedOutput: string;
  safetyBoundary: string;
  telemetry: string;
  nativeIdentity: string;
  version: string;
  publisher: string;
  signature: string;
  path: string;
  playbookTools: string;
  playbookOutput: string;
  inspectFirstTool: string;
  prepareDataset: string;
  datasetTaskCreated: string;
  format: string;
  safety: string;
}

const en: PrivateLabCopy = {
  title: "Private Lab",
  subtitle:
    "One place to inspect, understand and launch approved local security tools.",
  catalog: "Tool catalog",
  playbooks: "Playbooks",
  datasets: "Datasets",
  installed: "Installed",
  verified: "Verified",
  changed: "Needs review",
  availableTools: "Catalog entries",
  search: "Search tools, purposes or telemetry...",
  allCategories: "All categories",
  allInstallations: "All installation states",
  installedOnly: "Installed only",
  missingOnly: "Not registered",
  tool: "Tool",
  category: "Category",
  purpose: "Purpose",
  status: "Local status",
  actions: "Actions",
  guide: "Usage guide",
  openGuide: "Open usage guide",
  openNative: "Open in native tools",
  openSource: "Open official source",
  addTask: "Add acquisition task",
  taskCreated: "Acquisition task created",
  verifiedNative: "Registered · last check passed",
  identityChanged: "Binary identity changed",
  notRegistered: "Not registered",
  noMatch: "No tools match these filters.",
  selectTool: "Select a tool",
  selectToolHint:
    "Open a usage guide to see safe inputs, an example workflow and expected evidence.",
  starterWorkflow: "Starter workflow",
  commandPreview: "Example command",
  commandUnavailable:
    "No executable example is provided. Use a reviewed profile in an isolated lab.",
  requiredInputs: "Required inputs",
  workflowSteps: "Workflow",
  expectedOutput: "Expected output",
  safetyBoundary: "Scope and safety",
  telemetry: "Evidence to observe",
  nativeIdentity: "Native identity",
  version: "Version",
  publisher: "Publisher",
  signature: "Signature",
  path: "Executable",
  playbookTools: "Tool chain",
  playbookOutput: "Evidence package",
  inspectFirstTool: "Inspect first tool",
  prepareDataset: "Prepare dataset",
  datasetTaskCreated: "Dataset preparation task created",
  format: "Format",
  safety: "Safety",
};

const tr: PrivateLabCopy = {
  title: "Araç kılavuzları",
  subtitle:
    "Onaylı güvenlik araçlarını incelemek, öğrenmek ve başlatmak için tek yer.",
  catalog: "Araçlar",
  playbooks: "Akışlar",
  datasets: "Örnek veriler",
  installed: "Kurulu",
  verified: "Doğrulanmış",
  changed: "İnceleme gerekli",
  availableTools: "Katalog kaydı",
  search: "Araç, amaç ya da kanıt türü ara…",
  allCategories: "Tüm kategoriler",
  allInstallations: "Tüm kurulum durumları",
  installedOnly: "Yalnızca kurulu",
  missingOnly: "Kayıtlı olmayan",
  tool: "Araç",
  category: "Kategori",
  purpose: "Kullanım amacı",
  status: "Bu bilgisayarda",
  actions: "İşlemler",
  guide: "Kullanım kılavuzu",
  openGuide: "Kılavuzu aç",
  openNative: "Araçlar bölümünde aç",
  openSource: "Resmî kaynağı aç",
  addTask: "Edinme görevi ekle",
  taskCreated: "Edinme görevi oluşturuldu",
  verifiedNative: "Kayıtlı · kimliği doğrulandı",
  identityChanged: "Dosya kimliği değişti",
  notRegistered: "Kayıtlı değil",
  noMatch: "Bu filtrelerle eşleşen araç yok.",
  selectTool: "Bir araç seçin",
  selectToolHint:
    "Güvenli girdileri, örnek akışı ve beklenen kanıtı görmek için bir aracın kılavuzunu açın.",
  starterWorkflow: "Başlangıç akışı",
  commandPreview: "Örnek komut",
  commandUnavailable:
    "Bu araç için hazır bir örnek komut yok. İncelediğiniz bir çalıştırma profiliyle başlatın.",
  requiredInputs: "Gerekli girdiler",
  workflowSteps: "Çalışma adımları",
  expectedOutput: "Beklenen çıktı",
  safetyBoundary: "Kapsam ve güvenlik",
  telemetry: "İzlenecek kanıt",
  nativeIdentity: "Dosya kimliği",
  version: "Sürüm",
  publisher: "Yayıncı",
  signature: "İmza",
  path: "Çalıştırılabilir dosya",
  playbookTools: "Araç zinciri",
  playbookOutput: "Kanıt paketi",
  inspectFirstTool: "İlk aracı incele",
  prepareDataset: "Örnek veriyi hazırla",
  datasetTaskCreated: "Örnek veri hazırlama görevi oluşturuldu",
  format: "Biçim",
  safety: "Güvenlik",
};

const localeCopy: Record<Exclude<Locale, "en" | "tr">, PrivateLabCopy> = {
  de: {
    title: "Privates Labor",
    subtitle:
      "Genehmigte lokale Sicherheitstools prüfen, verstehen und starten.",
    catalog: "Werkzeugkatalog",
    playbooks: "Abläufe",
    datasets: "Datensätze",
    installed: "Installiert",
    verified: "Verifiziert",
    changed: "Zu prüfen",
    availableTools: "Katalogeinträge",
    search: "Werkzeuge, Zwecke oder Telemetrie suchen...",
    allCategories: "Alle Kategorien",
    allInstallations: "Alle Installationszustände",
    installedOnly: "Nur installierte",
    missingOnly: "Nicht registriert",
    tool: "Werkzeug",
    category: "Kategorie",
    purpose: "Zweck",
    status: "Lokaler Status",
    actions: "Aktionen",
    guide: "Nutzungsanleitung",
    openGuide: "Nutzungsanleitung öffnen",
    openNative: "In lokalen Werkzeugen öffnen",
    openSource: "Offizielle Quelle öffnen",
    addTask: "Beschaffungsaufgabe hinzufügen",
    taskCreated: "Beschaffungsaufgabe erstellt",
    verifiedNative: "Registriert · letzte Prüfung bestanden",
    identityChanged: "Dateiidentität geändert",
    notRegistered: "Nicht registriert",
    noMatch: "Keine Werkzeuge passen zu diesen Filtern.",
    selectTool: "Werkzeug auswählen",
    selectToolHint:
      "Öffnen Sie eine Nutzungsanleitung, um sichere Eingaben, einen Beispielablauf und die erwarteten Nachweise zu sehen.",
    starterWorkflow: "Einstiegsablauf",
    commandPreview: "Beispielbefehl",
    commandUnavailable:
      "Es gibt keinen ausführbaren Beispielbefehl. Verwenden Sie ein geprüftes Profil in einem isolierten Labor.",
    requiredInputs: "Erforderliche Eingaben",
    workflowSteps: "Ablauf",
    expectedOutput: "Erwartetes Ergebnis",
    safetyBoundary: "Umfang und Sicherheit",
    telemetry: "Zu beobachtende Nachweise",
    nativeIdentity: "Dateiidentität",
    version: "Version",
    publisher: "Herausgeber",
    signature: "Signatur",
    path: "Programmdatei",
    playbookTools: "Werkzeugkette",
    playbookOutput: "Nachweispaket",
    inspectFirstTool: "Erstes Werkzeug ansehen",
    prepareDataset: "Datensatz vorbereiten",
    datasetTaskCreated: "Aufgabe zur Datensatzvorbereitung erstellt",
    format: "Format",
    safety: "Sicherheit",
  },
  es: {
    title: "Laboratorio privado",
    subtitle:
      "Inspecciona, comprende e inicia herramientas de seguridad locales aprobadas.",
    catalog: "Catálogo de herramientas",
    playbooks: "Flujos de trabajo",
    datasets: "Conjuntos de datos",
    installed: "Instaladas",
    verified: "Verificadas",
    changed: "Por revisar",
    availableTools: "Entradas del catálogo",
    search: "Buscar herramientas, usos o telemetría...",
    allCategories: "Todas las categorías",
    allInstallations: "Todos los estados de instalación",
    installedOnly: "Solo instaladas",
    missingOnly: "Sin registrar",
    tool: "Herramienta",
    category: "Categoría",
    purpose: "Uso",
    status: "Estado local",
    actions: "Acciones",
    guide: "Guía de uso",
    openGuide: "Abrir guía de uso",
    openNative: "Abrir en herramientas locales",
    openSource: "Abrir la fuente oficial",
    addTask: "Añadir tarea de obtención",
    taskCreated: "Tarea de obtención creada",
    verifiedNative: "Registrada · última comprobación superada",
    identityChanged: "La identidad del binario cambió",
    notRegistered: "Sin registrar",
    noMatch: "Ninguna herramienta coincide con estos filtros.",
    selectTool: "Elige una herramienta",
    selectToolHint:
      "Abre una guía de uso para ver entradas seguras, un flujo de ejemplo y las pruebas esperadas.",
    starterWorkflow: "Flujo inicial",
    commandPreview: "Comando de ejemplo",
    commandUnavailable:
      "No hay ningún comando de ejemplo ejecutable. Usa un perfil revisado en un laboratorio aislado.",
    requiredInputs: "Entradas necesarias",
    workflowSteps: "Pasos",
    expectedOutput: "Resultado esperado",
    safetyBoundary: "Alcance y seguridad",
    telemetry: "Pruebas que observar",
    nativeIdentity: "Identidad del archivo",
    version: "Versión",
    publisher: "Editor",
    signature: "Firma",
    path: "Ejecutable",
    playbookTools: "Cadena de herramientas",
    playbookOutput: "Paquete de pruebas",
    inspectFirstTool: "Ver la primera herramienta",
    prepareDataset: "Preparar conjunto de datos",
    datasetTaskCreated: "Tarea de preparación del conjunto de datos creada",
    format: "Formato",
    safety: "Seguridad",
  },
  fr: {
    title: "Laboratoire privé",
    subtitle:
      "Inspecter, comprendre et lancer les outils de sécurité locaux approuvés.",
    catalog: "Catalogue d'outils",
    playbooks: "Procédures",
    datasets: "Jeux de données",
    installed: "Installés",
    verified: "Vérifiés",
    changed: "À vérifier",
    availableTools: "Entrées du catalogue",
    search: "Rechercher outils, usages ou télémétrie...",
    allCategories: "Toutes les catégories",
    allInstallations: "Tous les états d'installation",
    installedOnly: "Installés uniquement",
    missingOnly: "Non enregistrés",
    tool: "Outil",
    category: "Catégorie",
    purpose: "Usage",
    status: "État local",
    actions: "Actions",
    guide: "Guide d'utilisation",
    openGuide: "Ouvrir le guide d'utilisation",
    openNative: "Ouvrir dans les outils locaux",
    openSource: "Ouvrir la source officielle",
    addTask: "Ajouter une tâche d'acquisition",
    taskCreated: "Tâche d'acquisition créée",
    verifiedNative: "Enregistré · dernier contrôle réussi",
    identityChanged: "L'identité du binaire a changé",
    notRegistered: "Non enregistré",
    noMatch: "Aucun outil ne correspond à ces filtres.",
    selectTool: "Sélectionnez un outil",
    selectToolHint:
      "Ouvrez un guide d'utilisation pour voir les entrées sûres, un exemple de déroulé et les preuves attendues.",
    starterWorkflow: "Procédure de départ",
    commandPreview: "Exemple de commande",
    commandUnavailable:
      "Aucun exemple de commande exécutable n'est fourni. Utilisez un profil vérifié dans un laboratoire isolé.",
    requiredInputs: "Entrées requises",
    workflowSteps: "Étapes",
    expectedOutput: "Résultat attendu",
    safetyBoundary: "Périmètre et sécurité",
    telemetry: "Preuves à observer",
    nativeIdentity: "Identité du fichier",
    version: "Version",
    publisher: "Éditeur",
    signature: "Signature",
    path: "Exécutable",
    playbookTools: "Chaîne d'outils",
    playbookOutput: "Dossier de preuves",
    inspectFirstTool: "Voir le premier outil",
    prepareDataset: "Préparer le jeu de données",
    datasetTaskCreated: "Tâche de préparation du jeu de données créée",
    format: "Format",
    safety: "Sécurité",
  },
  it: {
    title: "Laboratorio privato",
    subtitle:
      "Ispeziona, comprendi e avvia gli strumenti di sicurezza locali approvati.",
    catalog: "Catalogo strumenti",
    playbooks: "Flussi di lavoro",
    datasets: "Set di dati",
    installed: "Installati",
    verified: "Verificati",
    changed: "Da rivedere",
    availableTools: "Voci del catalogo",
    search: "Cerca strumenti, utilizzi o telemetria...",
    allCategories: "Tutte le categorie",
    allInstallations: "Tutti gli stati di installazione",
    installedOnly: "Solo installati",
    missingOnly: "Non registrati",
    tool: "Strumento",
    category: "Categoria",
    purpose: "Utilizzo",
    status: "Stato locale",
    actions: "Azioni",
    guide: "Guida d'uso",
    openGuide: "Apri guida d'uso",
    openNative: "Apri negli strumenti locali",
    openSource: "Apri la fonte ufficiale",
    addTask: "Aggiungi attività di acquisizione",
    taskCreated: "Attività di acquisizione creata",
    verifiedNative: "Registrato · ultimo controllo superato",
    identityChanged: "L'identità del binario è cambiata",
    notRegistered: "Non registrato",
    noMatch: "Nessuno strumento corrisponde a questi filtri.",
    selectTool: "Scegli uno strumento",
    selectToolHint:
      "Apri una guida d'uso per vedere input sicuri, un flusso di esempio e le prove attese.",
    starterWorkflow: "Flusso iniziale",
    commandPreview: "Comando di esempio",
    commandUnavailable:
      "Non è disponibile un comando di esempio eseguibile. Usa un profilo rivisto in un laboratorio isolato.",
    requiredInputs: "Input richiesti",
    workflowSteps: "Passaggi",
    expectedOutput: "Risultato atteso",
    safetyBoundary: "Ambito e sicurezza",
    telemetry: "Prove da osservare",
    nativeIdentity: "Identità del file",
    version: "Versione",
    publisher: "Editore",
    signature: "Firma",
    path: "Eseguibile",
    playbookTools: "Catena di strumenti",
    playbookOutput: "Pacchetto di prove",
    inspectFirstTool: "Vedi il primo strumento",
    prepareDataset: "Prepara il set di dati",
    datasetTaskCreated: "Attività di preparazione del set di dati creata",
    format: "Formato",
    safety: "Sicurezza",
  },
};

export function getPrivateLabCopy(locale: Locale): PrivateLabCopy {
  if (locale === "en") return en;
  if (locale === "tr") return tr;
  return localeCopy[locale];
}

const text = (
  enValue: string,
  trValue: string,
  deValue: string,
  esValue: string,
  frValue: string,
  itValue: string,
): LabText => ({
  en: enValue,
  tr: trValue,
  de: deValue,
  es: esValue,
  fr: frValue,
  it: itValue,
});

const baseGuides: Record<ToolCatalogEntry["category"], ToolUsageGuide> = {
  web: {
    goal: text(
      "Review an owned lab web target and preserve reproducible request evidence.",
      "Sahip olunan lab web hedefini incele ve tekrarlanabilir istek kanıtı sakla.",
      "Ein eigenes Lab-Webziel prüfen und reproduzierbare Anfragenachweise sichern.",
      "Revisa un objetivo web de laboratorio propio y conserva pruebas reproducibles de las solicitudes.",
      "Examiner une cible web de laboratoire dont vous êtes propriétaire et conserver des preuves reproductibles des requêtes.",
      "Rivedi un target web di laboratorio di tua proprietà e conserva prove riproducibili delle richieste.",
    ),
    command: "<tool> <authorized-lab-target>",
    inputs: [
      text(
        "An explicitly authorized local target",
        "Açıkça yetkilendirilmiş yerel hedef",
        "Ein ausdrücklich autorisiertes lokales Ziel",
        "Un objetivo local con autorización expresa",
        "Une cible locale expressément autorisée",
        "Un target locale esplicitamente autorizzato",
      ),
      text(
        "A written stop condition",
        "Yazılı durma koşulu",
        "Eine schriftliche Abbruchbedingung",
        "Una condición de parada por escrito",
        "Une condition d'arrêt écrite",
        "Una condizione di arresto scritta",
      ),
    ],
    steps: [
      text(
        "Confirm the target is inside the active scope.",
        "Hedefin etkin kapsamda olduğunu doğrula.",
        "Bestätigen Sie, dass das Ziel im aktiven Geltungsbereich liegt.",
        "Confirma que el objetivo está dentro del alcance activo.",
        "Confirmer que la cible est dans le périmètre actif.",
        "Conferma che il target rientri nell'ambito attivo.",
      ),
      text(
        "Use the least invasive approved profile.",
        "En düşük etkili onaylı profili kullan.",
        "Verwenden Sie das am wenigsten invasive freigegebene Profil.",
        "Usa el perfil aprobado menos invasivo.",
        "Utiliser le profil approuvé le moins intrusif.",
        "Usa il profilo approvato meno invasivo.",
      ),
      text(
        "Save requests, responses and timestamps.",
        "İstekleri, yanıtları ve zaman damgalarını sakla.",
        "Speichern Sie Anfragen, Antworten und Zeitstempel.",
        "Guarda las solicitudes, las respuestas y las marcas de tiempo.",
        "Enregistrer les requêtes, les réponses et les horodatages.",
        "Salva richieste, risposte e timestamp.",
      ),
    ],
    expected: [
      text(
        "Request history and reviewed observations",
        "İstek geçmişi ve incelenmiş gözlemler",
        "Anfrageverlauf und geprüfte Beobachtungen",
        "Historial de solicitudes y observaciones revisadas",
        "Historique des requêtes et observations vérifiées",
        "Cronologia delle richieste e osservazioni riviste",
      ),
      text(
        "No claim without reproducible evidence",
        "Tekrarlanabilir kanıt olmadan bulgu iddiası yok",
        "Keine Behauptung ohne reproduzierbaren Nachweis",
        "Ninguna afirmación sin pruebas reproducibles",
        "Aucune affirmation sans preuve reproductible",
        "Nessuna affermazione senza prove riproducibili",
      ),
    ],
    boundary: text(
      "Owned fixtures only. Never use discovery or automated validation against public systems.",
      "Yalnızca sahip olunan örnekler. Genel sistemlerde keşif veya otomatik doğrulama yapma.",
      "Nur eigene Beispielumgebungen. Setzen Sie Erkundung oder automatisierte Prüfung nie gegen öffentliche Systeme ein.",
      "Solo entornos de ejemplo propios. Nunca uses descubrimiento ni validación automatizada contra sistemas públicos.",
      "Uniquement des environnements d'exemple dont vous êtes propriétaire. Ne jamais lancer de découverte ni de validation automatisée contre des systèmes publics.",
      "Solo esempi di tua proprietà. Non usare mai discovery o validazione automatica su sistemi pubblici.",
    ),
  },
  network: {
    goal: text(
      "Inspect prepared traffic or inventory services inside a written lab scope.",
      "Hazır trafiği incele veya yazılı lab kapsamındaki servisleri envanterle.",
      "Vorbereiteten Datenverkehr prüfen oder Dienste innerhalb eines schriftlich festgelegten Lab-Umfangs erfassen.",
      "Inspecciona tráfico preparado o inventaría servicios dentro de un alcance de laboratorio escrito.",
      "Examiner du trafic préparé ou inventorier des services dans un périmètre de laboratoire défini par écrit.",
      "Ispeziona traffico preparato o inventaria i servizi entro un ambito di laboratorio definito per iscritto.",
    ),
    command: "<tool> <prepared-capture-or-authorized-target>",
    inputs: [
      text(
        "Prepared PCAP or authorized target",
        "Hazır PCAP veya yetkili hedef",
        "Vorbereitete PCAP oder autorisiertes Ziel",
        "PCAP preparado o objetivo autorizado",
        "PCAP préparé ou cible autorisée",
        "PCAP preparato o target autorizzato",
      ),
      text(
        "Scope and rate limits",
        "Kapsam ve hız sınırları",
        "Geltungsbereich und Ratenlimits",
        "Alcance y límites de velocidad",
        "Périmètre et limites de débit",
        "Ambito e limiti di frequenza",
      ),
    ],
    steps: [
      text(
        "Validate the target or capture provenance.",
        "Hedefi veya yakalama kaynağını doğrula.",
        "Prüfen Sie die Herkunft von Ziel oder Mitschnitt.",
        "Valida el origen del objetivo o de la captura.",
        "Vérifier l'origine de la cible ou de la capture.",
        "Verifica l'origine del target o della cattura.",
      ),
      text(
        "Run the approved read-only or low-rate profile.",
        "Onaylı salt-okunur veya düşük hızlı profili çalıştır.",
        "Führen Sie das freigegebene schreibgeschützte oder langsame Profil aus.",
        "Ejecuta el perfil aprobado de solo lectura o de baja velocidad.",
        "Lancer le profil approuvé en lecture seule ou à faible débit.",
        "Esegui il profilo approvato in sola lettura o a bassa frequenza.",
      ),
      text(
        "Record flows, timestamps and service evidence.",
        "Akışları, zamanları ve servis kanıtını kaydet.",
        "Halten Sie Datenflüsse, Zeitstempel und Dienstnachweise fest.",
        "Registra los flujos, las marcas de tiempo y las pruebas de los servicios.",
        "Consigner les flux, les horodatages et les preuves sur les services.",
        "Registra flussi, timestamp e prove dei servizi.",
      ),
    ],
    expected: [
      text(
        "Protocol, flow or service inventory",
        "Protokol, akış veya servis envanteri",
        "Protokoll-, Datenfluss- oder Dienstinventar",
        "Inventario de protocolos, flujos o servicios",
        "Inventaire des protocoles, des flux ou des services",
        "Inventario di protocolli, flussi o servizi",
      ),
      text(
        "Firewall and endpoint telemetry correlation",
        "Güvenlik duvarı ve uç nokta telemetri korelasyonu",
        "Korrelation mit Firewall- und Endpunkt-Telemetrie",
        "Correlación con la telemetría del cortafuegos y de los equipos",
        "Corrélation avec la télémétrie du pare-feu et des postes",
        "Correlazione con la telemetria di firewall ed endpoint",
      ),
    ],
    boundary: text(
      "No public scanning, interception or credential capture. Use fixture networks and prepared captures.",
      "Genel ağ taraması, dinleme veya kimlik bilgisi yakalama yok. Örnek ağlar ve hazır yakalamalar kullan.",
      "Kein Scannen öffentlicher Netze, kein Abfangen und keine Erfassung von Zugangsdaten. Nutzen Sie Beispielnetze und vorbereitete Mitschnitte.",
      "Nada de escaneo público, interceptación ni captura de credenciales. Usa redes de ejemplo y capturas preparadas.",
      "Ni analyse de réseaux publics, ni interception, ni capture d'identifiants. Utiliser des réseaux d'exemple et des captures préparées.",
      "Niente scansioni pubbliche, intercettazioni o cattura di credenziali. Usa reti di esempio e catture preparate.",
    ),
  },
  password: {
    goal: text(
      "Measure password-policy strength with synthetic hashes.",
      "Sentetik özetlerle parola politikası dayanımını ölç.",
      "Die Stärke einer Passwortrichtlinie mit synthetischen Hashes messen.",
      "Mide la solidez de una política de contraseñas con hashes sintéticos.",
      "Mesurer la solidité d'une politique de mots de passe avec des hachages synthétiques.",
      "Misura la robustezza di una policy delle password con hash sintetici.",
    ),
    command: "<tool> <toy-hash-fixture>",
    inputs: [
      text(
        "Synthetic hashes created for the lab",
        "Lab için oluşturulmuş sentetik özetler",
        "Für das Labor erzeugte synthetische Hashes",
        "Hashes sintéticos creados para el laboratorio",
        "Hachages synthétiques créés pour le laboratoire",
        "Hash sintetici creati per il laboratorio",
      ),
      text(
        "A small approved wordlist",
        "Küçük, onaylı kelime listesi",
        "Eine kleine freigegebene Wortliste",
        "Una lista de palabras pequeña y aprobada",
        "Une petite liste de mots approuvée",
        "Una piccola wordlist approvata",
      ),
    ],
    steps: [
      text(
        "Verify that no real credentials are present.",
        "Gerçek kimlik bilgisi bulunmadığını doğrula.",
        "Stellen Sie sicher, dass keine echten Zugangsdaten enthalten sind.",
        "Comprueba que no hay credenciales reales.",
        "Vérifier qu'aucun identifiant réel n'est présent.",
        "Verifica che non ci siano credenziali reali.",
      ),
      text(
        "Run the bounded audit profile.",
        "Sınırlandırılmış denetim profilini çalıştır.",
        "Führen Sie das begrenzte Prüfprofil aus.",
        "Ejecuta el perfil de auditoría acotado.",
        "Lancer le profil d'audit limité.",
        "Esegui il profilo di audit limitato.",
      ),
      text(
        "Report policy findings, not recovered secrets.",
        "Kurtarılan sırları değil politika bulgularını raporla.",
        "Berichten Sie Richtlinienbefunde, nicht wiederhergestellte Geheimnisse.",
        "Informa de los hallazgos sobre la política, no de los secretos recuperados.",
        "Rapporter les constats sur la politique, pas les secrets retrouvés.",
        "Riporta i risultati sulla policy, non i segreti recuperati.",
      ),
    ],
    expected: [
      text(
        "Attempt-rate and policy metrics",
        "Deneme hızı ve politika metrikleri",
        "Versuchsrate und Richtlinienkennzahlen",
        "Métricas de intentos y de la política",
        "Métriques de cadence d'essais et de politique",
        "Metriche su tentativi e policy",
      ),
      text(
        "A remediation note",
        "İyileştirme notu",
        "Ein Hinweis zur Behebung",
        "Una nota de corrección",
        "Une note de remédiation",
        "Una nota di rimedio",
      ),
    ],
    boundary: text(
      "Synthetic lab hashes only. Do not process real credential material.",
      "Yalnızca sentetik lab özetleri. Gerçek kimlik bilgisi materyali işleme.",
      "Nur synthetische Lab-Hashes. Verarbeiten Sie keine echten Zugangsdaten.",
      "Solo hashes sintéticos de laboratorio. No proceses credenciales reales.",
      "Uniquement des hachages synthétiques de laboratoire. Ne pas traiter d'identifiants réels.",
      "Solo hash sintetici di laboratorio. Non elaborare credenziali reali.",
    ),
  },
  detection: {
    goal: text(
      "Evaluate a reviewed detection against sanitized telemetry.",
      "İncelenmiş bir tespiti temizlenmiş telemetri üzerinde değerlendir.",
      "Eine geprüfte Erkennung anhand bereinigter Telemetrie bewerten.",
      "Evalúa una detección revisada con telemetría depurada.",
      "Évaluer une détection vérifiée sur une télémétrie nettoyée.",
      "Valuta un rilevamento rivisto su telemetria ripulita.",
    ),
    command: "<tool> <reviewed-rule> <fixture-data>",
    inputs: [
      text(
        "Reviewed rule or signature",
        "İncelenmiş kural veya imza",
        "Geprüfte Regel oder Signatur",
        "Regla o firma revisada",
        "Règle ou signature vérifiée",
        "Regola o firma rivista",
      ),
      text(
        "Sanitized event, file or packet fixture",
        "Temizlenmiş olay, dosya veya paket örneği",
        "Bereinigtes Beispiel für Ereignis, Datei oder Paket",
        "Ejemplo depurado de evento, archivo o paquete",
        "Exemple nettoyé d'événement, de fichier ou de paquet",
        "Esempio ripulito di evento, file o pacchetto",
      ),
    ],
    steps: [
      text(
        "Document the expected signal.",
        "Beklenen sinyali belgele.",
        "Dokumentieren Sie das erwartete Signal.",
        "Documenta la señal esperada.",
        "Documenter le signal attendu.",
        "Documenta il segnale atteso.",
      ),
      text(
        "Run against the prepared fixture.",
        "Hazır örnek üzerinde çalıştır.",
        "Führen Sie die Prüfung am vorbereiteten Beispiel aus.",
        "Ejecútala sobre el ejemplo preparado.",
        "Lancer l'analyse sur l'exemple préparé.",
        "Eseguila sull'esempio preparato.",
      ),
      text(
        "Compare true positives, misses and noise.",
        "Doğru pozitifleri, kaçanları ve gürültüyü karşılaştır.",
        "Vergleichen Sie Treffer, Fehlstellen und Rauschen.",
        "Compara los aciertos, los fallos y el ruido.",
        "Comparer les vrais positifs, les détections manquées et le bruit.",
        "Confronta veri positivi, mancati rilevamenti e rumore.",
      ),
    ],
    expected: [
      text(
        "Rule matches with source evidence",
        "Kaynak kanıtıyla kural eşleşmeleri",
        "Regeltreffer mit Quellnachweis",
        "Coincidencias de reglas con la prueba de origen",
        "Correspondances de règles avec la preuve source",
        "Corrispondenze delle regole con la prova di origine",
      ),
      text(
        "False-positive and coverage notes",
        "Yanlış pozitif ve kapsama notları",
        "Hinweise zu Fehlalarmen und Abdeckung",
        "Notas sobre falsos positivos y cobertura",
        "Notes sur les faux positifs et la couverture",
        "Note su falsi positivi e copertura",
      ),
    ],
    boundary: text(
      "Use reviewed rules and non-sensitive fixtures. Treat matches as observations until validated.",
      "İncelenmiş kurallar ve hassas olmayan örnekler kullan. Doğrulanana kadar eşleşmeleri gözlem say.",
      "Verwenden Sie geprüfte Regeln und unkritische Beispiele. Behandeln Sie Treffer als Beobachtungen, bis sie bestätigt sind.",
      "Usa reglas revisadas y ejemplos no sensibles. Considera las coincidencias como observaciones hasta que se validen.",
      "Utiliser des règles vérifiées et des exemples non sensibles. Considérer les correspondances comme des observations tant qu'elles ne sont pas validées.",
      "Usa regole riviste ed esempi non sensibili. Considera le corrispondenze semplici osservazioni finché non sono validate.",
    ),
  },
  dfir: {
    goal: text(
      "Triage an offline fixture while preserving provenance.",
      "Kaynak bilgisini koruyarak çevrimdışı bir örneği triyaj et.",
      "Ein Offline-Beispiel sichten und dabei die Herkunft erhalten.",
      "Haz el triaje de un ejemplo sin conexión conservando su procedencia.",
      "Trier un exemple hors ligne en conservant sa provenance.",
      "Fai il triage di un esempio offline preservandone la provenienza.",
    ),
    command: "<tool> <read-only-fixture>",
    inputs: [
      text(
        "A copied, hashed fixture",
        "Kopyalanmış ve özeti alınmış örnek",
        "Eine kopierte Beispieldatei mit berechnetem Hash",
        "Un ejemplo copiado y con su hash calculado",
        "Un exemple copié, dont le hachage est calculé",
        "Un esempio copiato, con hash calcolato",
      ),
      text(
        "Case notes and acquisition source",
        "Vaka notları ve edinme kaynağı",
        "Fallnotizen und Beschaffungsquelle",
        "Notas del caso y fuente de obtención",
        "Notes du dossier et source d'acquisition",
        "Note del caso e fonte di acquisizione",
      ),
    ],
    steps: [
      text(
        "Record the original hash and source.",
        "Asıl özeti ve kaynağı kaydet.",
        "Halten Sie Original-Hash und Quelle fest.",
        "Registra el hash original y la fuente.",
        "Consigner le hachage d'origine et la source.",
        "Registra l'hash originale e la fonte.",
      ),
      text(
        "Analyze a working copy in read-only mode.",
        "Çalışma kopyasını salt-okunur biçimde analiz et.",
        "Analysieren Sie eine Arbeitskopie schreibgeschützt.",
        "Analiza una copia de trabajo en modo de solo lectura.",
        "Analyser une copie de travail en lecture seule.",
        "Analizza una copia di lavoro in sola lettura.",
      ),
      text(
        "Attach timestamps and extracted observations.",
        "Zaman damgalarını ve çıkarılan gözlemleri ekle.",
        "Ergänzen Sie Zeitstempel und gewonnene Beobachtungen.",
        "Añade las marcas de tiempo y las observaciones extraídas.",
        "Joindre les horodatages et les observations extraites.",
        "Aggiungi timestamp e osservazioni estratte.",
      ),
    ],
    expected: [
      text(
        "Timeline, metadata or artifact inventory",
        "Zaman çizelgesi, üst veri veya eser envanteri",
        "Zeitleiste, Metadaten oder Artefaktinventar",
        "Línea de tiempo, metadatos o inventario de artefactos",
        "Chronologie, métadonnées ou inventaire des artefacts",
        "Timeline, metadati o inventario degli artefatti",
      ),
      text(
        "Reproducible evidence references",
        "Tekrarlanabilir kanıt referansları",
        "Reproduzierbare Nachweisverweise",
        "Referencias a pruebas reproducibles",
        "Références de preuves reproductibles",
        "Riferimenti a prove riproducibili",
      ),
    ],
    boundary: text(
      "Offline prepared images and files only. Do not collect from third-party endpoints.",
      "Yalnızca çevrimdışı hazır imaj ve dosyalar. Üçüncü taraf uç noktalardan veri toplama.",
      "Nur vorbereitete Offline-Abbilder und -Dateien. Erfassen Sie keine Daten von Endgeräten Dritter.",
      "Solo imágenes y archivos preparados sin conexión. No recopiles datos de equipos de terceros.",
      "Uniquement des images et fichiers préparés hors ligne. Ne rien collecter sur des postes tiers.",
      "Solo immagini e file preparati offline. Non raccogliere dati da endpoint di terzi.",
    ),
  },
  reverse: {
    goal: text(
      "Inspect a harmless or reviewed binary without executing it.",
      "Zararsız veya incelenmiş bir ikiliyi çalıştırmadan incele.",
      "Eine harmlose oder geprüfte Binärdatei untersuchen, ohne sie auszuführen.",
      "Inspecciona un binario inofensivo o revisado sin ejecutarlo.",
      "Examiner un binaire inoffensif ou vérifié sans l'exécuter.",
      "Ispeziona un binario innocuo o rivisto senza eseguirlo.",
    ),
    command: "<tool> <prepared-fixture-binary>",
    inputs: [
      text(
        "A harmless fixture with known hash",
        "Özeti bilinen zararsız örnek",
        "Ein harmloses Beispiel mit bekanntem Hash",
        "Un ejemplo inofensivo con hash conocido",
        "Un exemple inoffensif au hachage connu",
        "Un esempio innocuo con hash noto",
      ),
      text(
        "An isolated analysis workspace",
        "Yalıtılmış analiz ortamı",
        "Eine isolierte Analyseumgebung",
        "Un entorno de análisis aislado",
        "Un environnement d'analyse isolé",
        "Un ambiente di analisi isolato",
      ),
    ],
    steps: [
      text(
        "Verify the fixture hash and provenance.",
        "Örnek özetini ve kaynağını doğrula.",
        "Prüfen Sie Hash und Herkunft des Beispiels.",
        "Verifica el hash y la procedencia del ejemplo.",
        "Vérifier le hachage et la provenance de l'exemple.",
        "Verifica hash e provenienza dell'esempio.",
      ),
      text(
        "Inspect format, imports, strings and control flow.",
        "Biçim, içe aktarımlar, dizeler ve kontrol akışını incele.",
        "Untersuchen Sie Format, Importe, Zeichenketten und Kontrollfluss.",
        "Examina el formato, las importaciones, las cadenas y el flujo de control.",
        "Examiner le format, les imports, les chaînes et le flux de contrôle.",
        "Esamina formato, import, stringhe e flusso di controllo.",
      ),
      text(
        "Save observations without executing the sample.",
        "Örneği çalıştırmadan gözlemleri kaydet.",
        "Speichern Sie Beobachtungen, ohne das Beispiel auszuführen.",
        "Guarda las observaciones sin ejecutar la muestra.",
        "Enregistrer les observations sans exécuter l'échantillon.",
        "Salva le osservazioni senza eseguire il campione.",
      ),
    ],
    expected: [
      text(
        "File structure and capability notes",
        "Dosya yapısı ve yetenek notları",
        "Dateistruktur und Hinweise zu Fähigkeiten",
        "Estructura del archivo y notas sobre sus capacidades",
        "Structure du fichier et notes sur ses capacités",
        "Struttura del file e note sulle capacità",
      ),
      text(
        "Referenced offsets, symbols or functions",
        "Referans verilen ofset, sembol veya işlevler",
        "Referenzierte Offsets, Symbole oder Funktionen",
        "Desplazamientos, símbolos o funciones referenciados",
        "Offsets, symboles ou fonctions référencés",
        "Offset, simboli o funzioni referenziati",
      ),
    ],
    boundary: text(
      "Static analysis of harmless or reviewed fixtures only. Unknown samples stay outside the host.",
      "Yalnızca zararsız veya incelenmiş örneklerde statik analiz. Bilinmeyen örnekler ana makineye alınmaz.",
      "Nur statische Analyse harmloser oder geprüfter Beispiele. Unbekannte Proben bleiben außerhalb des Hostsystems.",
      "Solo análisis estático de ejemplos inofensivos o revisados. Las muestras desconocidas no entran en el equipo anfitrión.",
      "Uniquement l'analyse statique d'exemples inoffensifs ou vérifiés. Les échantillons inconnus restent hors de l'hôte.",
      "Solo analisi statica di esempi innocui o rivisti. I campioni sconosciuti restano fuori dall'host.",
    ),
  },
  code: {
    goal: text(
      "Audit an owned repository and produce a reviewable evidence bundle.",
      "Sahip olunan depoyu denetle ve incelenebilir kanıt paketi üret.",
      "Ein eigenes Repository prüfen und ein nachprüfbares Nachweispaket erstellen.",
      "Audita un repositorio propio y genera un paquete de pruebas revisable.",
      "Auditer un dépôt dont vous êtes propriétaire et produire un dossier de preuves vérifiable.",
      "Esegui l'audit di un repository di tua proprietà e produci un pacchetto di prove verificabile.",
    ),
    command: "<tool> <owned-project-folder>",
    inputs: [
      text(
        "An owned repository or prepared fixture",
        "Sahip olunan depo veya hazır örnek",
        "Ein eigenes Repository oder vorbereitetes Beispiel",
        "Un repositorio propio o un ejemplo preparado",
        "Un dépôt dont vous êtes propriétaire ou un exemple préparé",
        "Un repository di tua proprietà o un esempio preparato",
      ),
      text(
        "Pinned tool version and ruleset",
        "Sabitlenmiş araç sürümü ve kural seti",
        "Festgelegte Werkzeugversion und Regelsatz",
        "Versión de la herramienta y conjunto de reglas fijados",
        "Version de l'outil et jeu de règles figés",
        "Versione dello strumento e set di regole fissati",
      ),
    ],
    steps: [
      text(
        "Confirm the repository path and exclusions.",
        "Depo yolunu ve hariç tutmaları doğrula.",
        "Bestätigen Sie Repository-Pfad und Ausschlüsse.",
        "Confirma la ruta del repositorio y las exclusiones.",
        "Confirmer le chemin du dépôt et les exclusions.",
        "Conferma il percorso del repository e le esclusioni.",
      ),
      text(
        "Run the approved local scan profile.",
        "Onaylı yerel tarama profilini çalıştır.",
        "Führen Sie das freigegebene lokale Scan-Profil aus.",
        "Ejecuta el perfil de análisis local aprobado.",
        "Lancer le profil d'analyse local approuvé.",
        "Esegui il profilo di scansione locale approvato.",
      ),
      text(
        "Review findings before creating issues.",
        "Sorun oluşturmadan önce bulguları incele.",
        "Prüfen Sie die Befunde, bevor Sie Tickets anlegen.",
        "Revisa los hallazgos antes de crear incidencias.",
        "Vérifier les constats avant de créer des tickets.",
        "Rivedi i risultati prima di aprire ticket.",
      ),
    ],
    expected: [
      text(
        "Machine-readable report or SBOM",
        "Makinece okunabilir rapor veya SBOM",
        "Maschinenlesbarer Bericht oder SBOM",
        "Informe legible por máquina o SBOM",
        "Rapport lisible par machine ou SBOM",
        "Report leggibile da macchina o SBOM",
      ),
      text(
        "Reviewed findings with file references",
        "Dosya referanslı incelenmiş bulgular",
        "Geprüfte Befunde mit Dateiverweisen",
        "Hallazgos revisados con referencias a archivos",
        "Constats vérifiés avec références aux fichiers",
        "Risultati rivisti con riferimenti ai file",
      ),
    ],
    boundary: text(
      "Owned repositories only. Never upload source, secrets or reports to third-party services.",
      "Yalnızca sahip olunan depolar. Kaynak kodu, sırları veya raporları üçüncü taraflara yükleme.",
      "Nur eigene Repositorys. Laden Sie Quellcode, Geheimnisse oder Berichte nie zu Diensten Dritter hoch.",
      "Solo repositorios propios. Nunca subas código fuente, secretos ni informes a servicios de terceros.",
      "Uniquement des dépôts dont vous êtes propriétaire. Ne jamais envoyer de code source, de secrets ou de rapports à des services tiers.",
      "Solo repository di tua proprietà. Non caricare mai codice sorgente, segreti o report su servizi di terzi.",
    ),
  },
  emulation: {
    goal: text(
      "Review an ATT&CK-aligned exercise plan before controlled execution.",
      "Kontrollü yürütmeden önce ATT&CK uyumlu alıştırma planını incele.",
      "Einen an ATT&CK ausgerichteten Übungsplan vor der kontrollierten Durchführung prüfen.",
      "Revisa un plan de ejercicio alineado con ATT&CK antes de la ejecución controlada.",
      "Examiner un plan d'exercice aligné sur ATT&CK avant l'exécution contrôlée.",
      "Rivedi un piano di esercitazione allineato ad ATT&CK prima dell'esecuzione controllata.",
    ),
    inputs: [
      text(
        "Reviewed test case",
        "İncelenmiş test senaryosu",
        "Geprüfter Testfall",
        "Caso de prueba revisado",
        "Cas de test vérifié",
        "Caso di test rivisto",
      ),
      text(
        "Disposable VM snapshot and stop conditions",
        "Atılabilir VM anlık görüntüsü ve durma koşulları",
        "Wegwerf-VM-Snapshot und Abbruchbedingungen",
        "Instantánea de una VM desechable y condiciones de parada",
        "Instantané d'une VM jetable et conditions d'arrêt",
        "Snapshot di una VM usa e getta e condizioni di arresto",
      ),
    ],
    steps: [
      text(
        "Review the procedure and expected telemetry.",
        "Prosedürü ve beklenen telemetriyi incele.",
        "Prüfen Sie Vorgehen und erwartete Telemetrie.",
        "Revisa el procedimiento y la telemetría esperada.",
        "Examiner la procédure et la télémétrie attendue.",
        "Rivedi la procedura e la telemetria attesa.",
      ),
      text(
        "Confirm isolation, rollback and authorization.",
        "Yalıtımı, geri dönüşü ve yetkiyi doğrula.",
        "Bestätigen Sie Isolation, Rücksetzung und Genehmigung.",
        "Confirma el aislamiento, la reversión y la autorización.",
        "Confirmer l'isolation, le retour arrière et l'autorisation.",
        "Conferma isolamento, ripristino e autorizzazione.",
      ),
      text(
        "Use only the pre-approved native profile.",
        "Yalnızca önceden onaylanmış native profili kullan.",
        "Verwenden Sie nur das vorab freigegebene native Profil.",
        "Usa solo el perfil nativo aprobado de antemano.",
        "Utiliser uniquement le profil natif approuvé au préalable.",
        "Usa solo il profilo nativo approvato in anticipo.",
      ),
    ],
    expected: [
      text(
        "Execution record and defensive telemetry",
        "Çalıştırma kaydı ve savunma telemetrisi",
        "Ausführungsprotokoll und Telemetrie der Verteidigung",
        "Registro de la ejecución y telemetría defensiva",
        "Journal d'exécution et télémétrie défensive",
        "Registro dell'esecuzione e telemetria difensiva",
      ),
      text(
        "Rollback and debrief evidence",
        "Geri dönüş ve değerlendirme kanıtı",
        "Nachweise zu Rücksetzung und Nachbesprechung",
        "Pruebas de la reversión y de la reunión de cierre",
        "Preuves du retour arrière et du débriefing",
        "Prove del ripristino e del debriefing",
      ),
    ],
    boundary: text(
      "Disposable isolated VM only. No payload development, persistence, C2 or data collection.",
      "Yalnızca yalıtılmış atılabilir VM. Yük geliştirme, kalıcılık, C2 veya veri toplama yok.",
      "Nur isolierte Wegwerf-VM. Keine Payload-Entwicklung, keine Persistenz, kein C2 und keine Datenerfassung.",
      "Solo una VM aislada y desechable. Sin desarrollo de payloads, persistencia, C2 ni recopilación de datos.",
      "Uniquement une VM jetable et isolée. Pas de développement de charges utiles, de persistance, de C2 ni de collecte de données.",
      "Solo una VM isolata e usa e getta. Niente sviluppo di payload, persistenza, C2 o raccolta di dati.",
    ),
  },
  threat_concepts: {
    goal: text(
      "Study reports and defensive telemetry without obtaining or running samples.",
      "Örnek edinmeden veya çalıştırmadan raporları ve savunma telemetrisini incele.",
      "Berichte und defensive Telemetrie studieren, ohne Proben zu beschaffen oder auszuführen.",
      "Estudia informes y telemetría defensiva sin obtener ni ejecutar muestras.",
      "Étudier des rapports et de la télémétrie défensive sans obtenir ni exécuter d'échantillons.",
      "Studia report e telemetria difensiva senza ottenere né eseguire campioni.",
    ),
    inputs: [
      text(
        "Public reports and sanitized telemetry",
        "Genel raporlar ve temizlenmiş telemetri",
        "Öffentliche Berichte und bereinigte Telemetrie",
        "Informes públicos y telemetría depurada",
        "Rapports publics et télémétrie nettoyée",
        "Report pubblici e telemetria ripulita",
      ),
      text(
        "A defensive analysis question",
        "Savunma odaklı analiz sorusu",
        "Eine Fragestellung für die defensive Analyse",
        "Una pregunta de análisis defensivo",
        "Une question d'analyse défensive",
        "Una domanda di analisi difensiva",
      ),
    ],
    steps: [
      text(
        "Map reported behavior to observable signals.",
        "Raporlanan davranışı gözlenebilir sinyallere eşle.",
        "Ordnen Sie berichtetes Verhalten beobachtbaren Signalen zu.",
        "Relaciona el comportamiento descrito con señales observables.",
        "Associer le comportement décrit à des signaux observables.",
        "Collega il comportamento riportato a segnali osservabili.",
      ),
      text(
        "Separate sourced facts from analyst inference.",
        "Kaynaklı gerçekleri analist çıkarımından ayır.",
        "Trennen Sie belegte Fakten von Schlüssen der Analysten.",
        "Separa los hechos con fuente de las deducciones del analista.",
        "Séparer les faits sourcés des déductions de l'analyste.",
        "Separa i fatti documentati dalle deduzioni dell'analista.",
      ),
      text(
        "Write detection and containment notes.",
        "Tespit ve sınırlandırma notları yaz.",
        "Schreiben Sie Notizen zu Erkennung und Eindämmung.",
        "Redacta notas de detección y contención.",
        "Rédiger des notes de détection et de confinement.",
        "Scrivi note di rilevamento e contenimento.",
      ),
    ],
    expected: [
      text(
        "Behavior-to-telemetry map",
        "Davranış-telemetri eşlemesi",
        "Zuordnung von Verhalten zu Telemetrie",
        "Mapa de comportamiento a telemetría",
        "Correspondance entre comportements et télémétrie",
        "Mappa da comportamento a telemetria",
      ),
      text(
        "Defensive hypotheses with sources",
        "Kaynaklı savunma hipotezleri",
        "Defensive Hypothesen mit Quellen",
        "Hipótesis defensivas con sus fuentes",
        "Hypothèses défensives avec leurs sources",
        "Ipotesi difensive con le fonti",
      ),
    ],
    boundary: text(
      "Concept and telemetry analysis only. No binaries, deployment, credential access, persistence or collection.",
      "Yalnızca kavram ve telemetri analizi. İkili, dağıtım, kimlik bilgisi erişimi, kalıcılık veya toplama yok.",
      "Nur Konzept- und Telemetrieanalyse. Keine Binärdateien, kein Einsatz, kein Zugriff auf Zugangsdaten, keine Persistenz und keine Datenerfassung.",
      "Solo análisis de conceptos y telemetría. Sin binarios, despliegue, acceso a credenciales, persistencia ni recopilación.",
      "Uniquement l'analyse des concepts et de la télémétrie. Pas de binaires, de déploiement, d'accès aux identifiants, de persistance ni de collecte.",
      "Solo analisi di concetti e telemetria. Niente binari, distribuzione, accesso alle credenziali, persistenza o raccolta.",
    ),
  },
};

const guideOverrides: Record<string, Partial<ToolUsageGuide>> = {
  nmap: {
    command: "nmap -sV --version-light <authorized-lab-target>",
  },
  wireshark: {
    command: "wireshark <prepared-capture.pcapng>",
  },
  ghidra: {
    command: "ghidra <prepared-fixture-binary>",
  },
  imhex: {
    command: "imhex <prepared-fixture-binary>",
  },
  "detect-it-easy": {
    command: "die <prepared-fixture-binary>",
  },
  "pe-bear": {
    command: "PE-bear <prepared-fixture.exe>",
  },
  dnspyex: {
    command: "dnSpy <owned-or-prepared-assembly.dll>",
  },
  ilspy: {
    command: "ILSpy <owned-or-prepared-assembly.dll>",
  },
  volatility: {
    command: "vol -f <prepared-memory.raw> windows.info.Info",
  },
  exiftool: {
    command: "exiftool -json <prepared-file>",
  },
  jq: {
    command: "jq '.events[] | select(.severity == \"high\")' <fixture-log.json>",
  },
  osquery: {
    command: "osqueryi \"SELECT name, pid FROM processes LIMIT 20;\"",
  },
  trivy: {
    command: "trivy fs --scanners vuln,secret,misconfig <owned-project>",
  },
  syft: {
    command: "syft <owned-project> -o cyclonedx-json",
  },
  grype: {
    command: "grype sbom:<approved-sbom.json>",
  },
  semgrep: {
    command: "semgrep scan --config <reviewed-ruleset> <owned-project>",
  },
  gitleaks: {
    command: "gitleaks detect --source <fixture-repository> --no-banner",
  },
  "yara-rules": {
    command: "yara <reviewed-rule.yar> <fixture-folder>",
  },
  cyberchef: {
    command: "Open the local CyberChef workspace and load a prepared text fixture.",
  },
};

const GUIDE_ONLY_TOOL_IDS = new Set([
  "atomic-red-team",
  "caldera",
  "velociraptor",
  "osquery",
  "wazuh",
  "nuclei",
  "sqlmap",
  "masscan",
  "responder",
  "metasploit",
  "bloodhound",
  "credential-concepts",
]);

export function getToolUsageGuide(tool: ToolCatalogEntry): ToolUsageGuide {
  const base = baseGuides[tool.category];
  if (GUIDE_ONLY_TOOL_IDS.has(tool.id) || !tool.repository) {
    return { ...base, command: undefined };
  }
  const override = guideOverrides[tool.id];
  return {
    ...base,
    ...override,
    inputs: override?.inputs ?? base.inputs,
    steps: override?.steps ?? base.steps,
    expected: override?.expected ?? base.expected,
  };
}

export const PRIVATE_LAB_PLAYBOOKS: LabPlaybook[] = [
  {
    id: "repository-audit",
    title: text(
      "Owned repository audit",
      "Sahip olunan depo denetimi",
      "Audit eines eigenen Repositorys",
      "Auditoría de repositorio propio",
      "Audit d'un dépôt interne",
      "Audit di un repository proprio",
    ),
    summary: text(
      "Find synthetic secrets, inventory dependencies and review known vulnerabilities.",
      "Sentetik sırları bul, bağımlılıkları envanterle ve bilinen zafiyetleri incele.",
      "Synthetische Geheimnisse finden, Abhängigkeiten erfassen und bekannte Schwachstellen prüfen.",
      "Encuentra secretos sintéticos, inventaría las dependencias y revisa las vulnerabilidades conocidas.",
      "Trouver des secrets synthétiques, inventorier les dépendances et examiner les vulnérabilités connues.",
      "Trova segreti sintetici, inventaria le dipendenze e rivedi le vulnerabilità note.",
    ),
    toolIds: ["gitleaks", "trivy", "syft", "grype"],
    output: text(
      "Secret-scan report, SBOM and reviewed vulnerability list.",
      "Sır tarama raporu, SBOM ve incelenmiş zafiyet listesi.",
      "Bericht zur Geheimnissuche, SBOM und geprüfte Schwachstellenliste.",
      "Informe de búsqueda de secretos, SBOM y lista de vulnerabilidades revisada.",
      "Rapport de recherche de secrets, SBOM et liste de vulnérabilités vérifiée.",
      "Report della ricerca di segreti, SBOM ed elenco delle vulnerabilità rivisto.",
    ),
  },
  {
    id: "binary-triage",
    title: text(
      "Offline binary triage",
      "Çevrimdışı ikili triyajı",
      "Binärdatei-Triage offline",
      "Triaje de binarios sin conexión",
      "Tri de binaires hors ligne",
      "Triage di binari offline",
    ),
    summary: text(
      "Identify a harmless fixture before deeper static analysis.",
      "Derin statik analizden önce zararsız bir örneği tanımla.",
      "Ein harmloses Beispiel identifizieren, bevor die tiefere statische Analyse beginnt.",
      "Identifica un ejemplo inofensivo antes de un análisis estático más profundo.",
      "Identifier un exemple inoffensif avant une analyse statique plus poussée.",
      "Identifica un esempio innocuo prima di un'analisi statica più approfondita.",
    ),
    toolIds: ["exiftool", "detect-it-easy", "imhex", "pe-bear", "ghidra"],
    output: text(
      "Hash, format, imports, strings and referenced functions.",
      "Özet, biçim, içe aktarımlar, dizeler ve referanslı işlevler.",
      "Hash, Format, Importe, Zeichenketten und referenzierte Funktionen.",
      "Hash, formato, importaciones, cadenas y funciones referenciadas.",
      "Hachage, format, imports, chaînes et fonctions référencées.",
      "Hash, formato, import, stringhe e funzioni referenziate.",
    ),
  },
  {
    id: "packet-triage",
    title: text(
      "Prepared packet triage",
      "Hazır paket triyajı",
      "Triage vorbereiteter Pakete",
      "Triaje de paquetes preparados",
      "Tri de paquets préparés",
      "Triage di pacchetti preparati",
    ),
    summary: text(
      "Inspect a sanitized capture and build a protocol timeline.",
      "Temizlenmiş yakalamayı incele ve protokol zaman çizelgesi oluştur.",
      "Einen bereinigten Mitschnitt untersuchen und eine Protokoll-Zeitleiste aufbauen.",
      "Inspecciona una captura depurada y construye una línea de tiempo de protocolos.",
      "Examiner une capture nettoyée et construire une chronologie des protocoles.",
      "Ispeziona una cattura ripulita e costruisci una timeline dei protocolli.",
    ),
    toolIds: ["wireshark", "zeek", "suricata"],
    output: text(
      "Flow inventory, protocol observations and alert correlation.",
      "Akış envanteri, protokol gözlemleri ve alarm korelasyonu.",
      "Datenflussinventar, Protokollbeobachtungen und Alarmkorrelation.",
      "Inventario de flujos, observaciones de protocolos y correlación de alertas.",
      "Inventaire des flux, observations sur les protocoles et corrélation des alertes.",
      "Inventario dei flussi, osservazioni sui protocolli e correlazione degli avvisi.",
    ),
  },
  {
    id: "memory-triage",
    title: text(
      "Memory image triage",
      "Bellek imajı triyajı",
      "Triage von Speicherabbildern",
      "Triaje de imágenes de memoria",
      "Tri d'images mémoire",
      "Triage di immagini di memoria",
    ),
    summary: text(
      "Establish image metadata, process context and a reproducible artifact list.",
      "İmaj üst verisini, süreç bağlamını ve tekrarlanabilir eser listesini çıkar.",
      "Abbild-Metadaten, Prozesskontext und eine reproduzierbare Artefaktliste ermitteln.",
      "Obtén los metadatos de la imagen, el contexto de los procesos y una lista de artefactos reproducible.",
      "Établir les métadonnées de l'image, le contexte des processus et une liste d'artefacts reproductible.",
      "Ricava i metadati dell'immagine, il contesto dei processi e un elenco di artefatti riproducibile.",
    ),
    toolIds: ["volatility", "yara-rules"],
    output: text(
      "Image profile, process list and reviewed pattern matches.",
      "İmaj profili, süreç listesi ve incelenmiş örüntü eşleşmeleri.",
      "Abbildprofil, Prozessliste und geprüfte Musterübereinstimmungen.",
      "Perfil de la imagen, lista de procesos y coincidencias de patrones revisadas.",
      "Profil de l'image, liste des processus et correspondances de motifs vérifiées.",
      "Profilo dell'immagine, elenco dei processi e corrispondenze di pattern riviste.",
    ),
  },
];
