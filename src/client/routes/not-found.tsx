import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { FileQuestion } from "lucide-react";
import { PageToolbar } from "../components/layout/page-toolbar";

export function NotFoundPage() {
	return (
		<div className="flex flex-col gap-4">
			<PageToolbar title="未找到" description="没有这个页面。" />
			<LayerCard>
				<LayerCard.Primary>
					<LayerCard.Empty icon={<FileQuestion />} title="未找到" description="没有这个页面。" />
				</LayerCard.Primary>
			</LayerCard>
		</div>
	);
}
