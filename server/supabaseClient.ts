import { createClient, type SupabaseClient } from '@supabase/supabase-js';

type CoverDesign = {
	id: string;
	creator_id: string;
	book_title: string;
	author: string | null;
	keywords: string[];
	front_image_path: string;
	back_image_path: string;
	spine_image_path: string;
	created_at: string;
};

type LibraryBook = {
	id: string;
	user_id: string;
	epub_path: string;
	title: string | null;
	author: string | null;
	design_id: string | null;
	height_m: number;
	width_m: number;
	thickness_m: number;
	progress: number;
	uploaded_at: string;
	last_read_at: string | null;
};

export type Database = {
	public: {
		Tables: {
			cover_designs: {
				Row: CoverDesign;
				Insert: Omit<CoverDesign, 'id' | 'created_at'> &
					Partial<Pick<CoverDesign, 'id' | 'created_at'>>;
				Update: Partial<Omit<CoverDesign, 'id' | 'creator_id' | 'created_at'>>;
			};
			library: {
				Row: LibraryBook;
				Insert: Omit<LibraryBook, 'id' | 'uploaded_at'> &
					Partial<Pick<LibraryBook, 'id' | 'uploaded_at'>>;
				Update: Partial<Omit<LibraryBook, 'id' | 'user_id' | 'uploaded_at'>>;
			};
		};
	};
};

function requiredEnvironment(name: string, fallbackName?: string): string {
	const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const supabaseUrl = requiredEnvironment('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
const supabaseAnonKey = requiredEnvironment('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

/** Create a client whose queries run under the supplied user's RLS identity. */
export function createSupabaseClient(accessToken?: string): SupabaseClient<Database> {
	return createClient<Database>(supabaseUrl, supabaseAnonKey, {
		global: accessToken
			? { headers: { Authorization: `Bearer ${accessToken}` } }
			: undefined,
	});
}

export const supabase = createSupabaseClient();