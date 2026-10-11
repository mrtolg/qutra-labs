import { Link } from "react-router-dom";
import { Compass } from "lucide-react";
import { useT } from "@/lib/i18n";
import { EmptyState } from "@/components/ui/EmptyState";

export default function NotFoundPage() {
  const { t } = useT();
  return (
    <div className="page">
      <div className="page-body">
        <EmptyState
          icon={Compass}
          title={t("notFound.title")}
          hint={t("notFound.body")}
          action={
            <Link to="/overview" className="btn btn--primary">
              {t("notFound.back")}
            </Link>
          }
        />
      </div>
    </div>
  );
}
