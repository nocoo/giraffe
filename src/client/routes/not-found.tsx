import { Empty } from "@nocoo/basalt/components/empty";
import { PageHeader } from "@nocoo/basalt/components/page-header";

export function NotFoundPage() {
	return (
		<div className="flex flex-col gap-4">
			<PageHeader title="未找到" />
			<Empty title="未找到" description="没有这个页面。" />
		</div>
	);
}
