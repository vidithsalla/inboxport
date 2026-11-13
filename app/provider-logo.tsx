import Image from "next/image";

type BrandedProvider = "google" | "outlook";

const providerAssets: Record<BrandedProvider, { alt: string; src: string }> = {
  google: { alt: "Gmail", src: "/brands/gmail.svg" },
  outlook: { alt: "Microsoft Outlook", src: "/brands/outlook.svg" },
};

export function ProviderLogo({
  provider,
  size = 28,
}: {
  provider: BrandedProvider;
  size?: number;
}) {
  const asset = providerAssets[provider];
  return <Image alt={asset.alt} height={size} src={asset.src} width={size} />;
}
