import { Button, Link } from "@nocoo/basalt";
import { LayerCard } from "@nocoo/basalt/components/layer-card";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { FileQuestion } from "lucide-react";
import { EmptyState } from "../components/layout/empty-state";

export function NotFoundPage() {
	return (
		<div className="space-y-8">
			<PageHeader title="未找到" description="没有这个页面。" />
			<LayerCard>
				<LayerCard.Body>
					<EmptyState
						icon={<FileQuestion />}
						title="页面不存在"
						description="链接可能已失效，也可以从侧栏继续浏览。"
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
