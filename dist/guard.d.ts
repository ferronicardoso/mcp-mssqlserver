export type Profile = 'reader' | 'dml' | 'ddl';
export interface GuardViolation {
    keyword: string;
    requiredProfile: 'dml' | 'ddl' | null;
}
export declare function parseProfile(raw: string | undefined): Profile;
/**
 * Remove comentários, literais de string e identificadores delimitados,
 * preservando o espaçamento para que tokens adjacentes não se fundam.
 * Identificadores delimitados viram o placeholder "x" para continuarem
 * contando como token (ex.: [dbo].[proc] no início de batch).
 * Trechos não terminados são removidos até o fim (o servidor rejeita o SQL
 * malformado de qualquer forma).
 */
export declare function stripSql(sql: string): string;
/**
 * Classificador em duas camadas sobre o SQL já limpo:
 * 1. allowlist estrita no início de cada instrução (nega desconhecidos);
 * 2. varredura de verbos de escrita/DDL em profundidade 0 de parênteses,
 *    pois T-SQL não exige ponto e vírgula entre instruções e CTEs podem
 *    terminar em DML (os corpos de CTE ficam em profundidade >= 1).
 */
export declare function findViolation(query: string, profile: Profile): GuardViolation | null;
export declare function assertQueryAllowed(query: string, profile: Profile): void;
export declare function describeExecuteQueryTool(profile: Profile): string;
//# sourceMappingURL=guard.d.ts.map