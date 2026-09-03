import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FileQuestion } from "lucide-react";

export function NotFoundPage() {
	return (
		<div className="space-y-8">
			<PageHeader title="未找到" description="没有这个页面。" />
			<LayerCard>
				<LayerCard.Well>
					<LayerCard.Empty icon={<FileQuestion />} title="未找到" description="没有这个页面。" />
				</LayerCard.Well>
			</LayerCard>
		</div>
	);
}
