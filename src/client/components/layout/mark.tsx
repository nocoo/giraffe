export function BrandMark({ alt = "" }: { alt?: string }) {
	return <img src="/logo-24.png" alt={alt} width={24} height={24} className="h-6 w-6 shrink-0" />;
}
