import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FileQuestion } from "@nocoo/basalt/icons";
import { EmptyState } from "../components/layout/empty-state";

export function NotFoundPage() {
	return (
		<div className="space-y-8">
			<PageHeader title="未找到" />
			<LayerCard>
				<LayerCard.Body>
					<EmptyState
						icon={<FileQuestion />}
						title="页面不存在"
						action={
							<Button size="sm" asChild>
								<Link href="/repos">返回仓库</Link>
							</Button>
						}
					/>
				</LayerCard.Body>
			</LayerCard>
		</div>
	);
}
