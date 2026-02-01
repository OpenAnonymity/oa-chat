import { DocumentsStore } from '../components/documents-store.js';
import { Index } from '../components/index.js';
import { Sorter } from '../components/sorter.js';
import { AnySchema, Components, IDocumentsStore, IIndex, ISorter, Orama, OramaPlugin, SorterConfig } from '../types.js';
interface CreateArguments<OramaSchema, TIndex, TDocumentStore, TSorter, TPinning> {
    schema: OramaSchema;
    sort?: SorterConfig;
    language?: string;
    components?: Components<Orama<OramaSchema, TIndex, TDocumentStore, TSorter, TPinning>, OramaSchema, TIndex, TDocumentStore, TSorter, TPinning>;
    plugins?: OramaPlugin[];
    id?: string;
}
export declare function create<OramaSchema extends AnySchema, TIndex = IIndex<Index>, TDocumentStore = IDocumentsStore<DocumentsStore>, TSorter = ISorter<Sorter>, TPinning = any>({ schema, sort, language, components, id, plugins }: CreateArguments<OramaSchema, TIndex, TDocumentStore, TSorter, TPinning>): Orama<OramaSchema, TIndex, TDocumentStore, TSorter, TPinning>;
export {};
